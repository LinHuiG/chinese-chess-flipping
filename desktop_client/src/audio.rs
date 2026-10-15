use crate::{
    wire::{self, Packet},
    AppState,
};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rand_core::{OsRng, RngCore};
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, Weak,
    },
    thread,
    time::{Duration, Instant},
};
const CODEC: &str = "ima-adpcm-16k-v1";
fn capture_discontinuity(anchor: Instant, clock: u32, at: Instant) -> bool {
    let expected = anchor + Duration::from_micros(clock as u64 * 1_000_000 / 16_000);
    at.saturating_duration_since(expected) > Duration::from_millis(120)
        || expected.saturating_duration_since(at) > Duration::from_millis(120)
}
const STEP: [i32; 89] = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66,
    73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449,
    494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272,
    2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493,
    10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];
const INDEX: [i32; 16] = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
fn nibble(code: u8, predictor: &mut i32, index: &mut i32) {
    let step = STEP[*index as usize];
    let mut diff = step >> 3;
    if code & 1 != 0 {
        diff += step >> 2
    }
    if code & 2 != 0 {
        diff += step >> 1
    }
    if code & 4 != 0 {
        diff += step
    }
    *predictor = (*predictor + if code & 8 != 0 { -diff } else { diff }).clamp(-32768, 32767);
    *index = (*index + INDEX[code as usize]).clamp(0, 88);
}
pub fn encode(samples: &[i16], stream: u32, seq: u32, clock: u32) -> Vec<u8> {
    let mut b = vec![0u8; 180];
    b[..4].copy_from_slice(b"CRV1");
    for (offset, n) in [(4, stream), (8, seq), (12, clock)] {
        b[offset..offset + 4].copy_from_slice(&n.to_le_bytes())
    }
    b[16..18].copy_from_slice(&samples[0].to_le_bytes());
    let mut p = samples[0] as i32;
    let mut index = 0;
    for (i, sample) in samples.iter().skip(1).enumerate() {
        let step = STEP[index as usize];
        let mut diff = *sample as i32 - p;
        let mut code = 0u8;
        if diff < 0 {
            code = 8;
            diff = -diff
        }
        if diff >= step {
            code |= 4;
            diff -= step
        }
        if diff >= step >> 1 {
            code |= 2;
            diff -= step >> 1
        }
        if diff >= step >> 2 {
            code |= 1
        }
        nibble(code, &mut p, &mut index);
        b[20 + i / 2] |= code << ((i % 2) * 4);
    }
    b
}
pub fn decode(b: &[u8]) -> Option<(u32, u32, Vec<i16>)> {
    if b.len() != 180 || &b[..4] != b"CRV1" || b[18] > 88 || b[19] != 0 {
        return None;
    }
    let stream = u32::from_le_bytes(b[4..8].try_into().ok()?);
    let seq = u32::from_le_bytes(b[8..12].try_into().ok()?);
    let mut p = i16::from_le_bytes(b[16..18].try_into().ok()?) as i32;
    let mut index = b[18] as i32;
    let mut samples = vec![p as i16];
    for i in 0..319 {
        nibble((b[20 + i / 2] >> ((i % 2) * 4)) & 15, &mut p, &mut index);
        samples.push(p as i16);
    }
    Some((stream, seq, samples))
}
#[derive(Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    room_id: String,
    self_id: String,
    members: Vec<String>,
    direct_targets: Vec<String>,
    enabled: bool,
    codec: String,
}
struct Source {
    stream: u32,
    seq: u32,
    frames: VecDeque<(u32, Instant, Vec<i16>)>,
    current: Vec<i16>,
    offset: usize,
    retired: VecDeque<u32>,
    anchor: Instant,
    clock: u32,
    received: u64,
    late: u64,
}
#[derive(Default)]
struct Mixer {
    sources: HashMap<String, Source>,
    phase: u32,
    value: f32,
    played_frames: u64,
    output_peak: f32,
}
impl Mixer {
    fn sample(&mut self) -> f32 {
        let now = Instant::now();
        let mut total = 0f32;
        for source in self.sources.values_mut() {
            if source.offset >= source.current.len() {
                while source.frames.front().is_some_and(|(_, at, _)| {
                    now.saturating_duration_since(*at) > Duration::from_millis(160)
                }) {
                    source.frames.pop_front();
                }
                if source.frames.front().is_some_and(|(_, at, _)| *at > now) {
                    continue;
                }
                if let Some((seq, _, data)) = source.frames.pop_front() {
                    self.played_frames += 1;
                    source.seq = seq;
                    source.current = data;
                    source.offset = 0
                } else {
                    continue;
                }
            }
            total += source.current[source.offset] as f32 / 32768.;
            source.offset += 1;
        }
        let value = total.clamp(-0.98, 0.98);
        self.output_peak = self.output_peak.max(value.abs());
        value
    }
}
pub struct Voice {
    state: Weak<AppState>,
    config: Mutex<Config>,
    mixer: Mutex<Mixer>,
    running: AtomicBool,
    microphone: AtomicBool,
    stop: AtomicBool,
    diagnostics: bool,
}
impl Voice {
    pub fn new(state: Weak<AppState>) -> Arc<Self> {
        Arc::new(Self {
            state,
            config: Mutex::new(Config::default()),
            mixer: Mutex::new(Mixer::default()),
            running: AtomicBool::new(false),
            microphone: AtomicBool::new(false),
            stop: AtomicBool::new(false),
            diagnostics: std::env::var("CYBER_ROOM_MEDIA_DIAGNOSTICS").as_deref() == Ok("1"),
        })
    }
    pub fn configure(self: &Arc<Self>, c: Config) -> Result<(), String> {
        if c.enabled
            && (!wire::valid_id(&c.room_id)
                || !wire::valid_id(&c.self_id)
                || c.members.len() > 6
                || c.codec != CODEC
                || !c.members.iter().all(|s| wire::valid_id(s))
                || !c.direct_targets.iter().all(|s| c.members.contains(s)))
        {
            return Err("无效语音配置".into());
        }
        let changed = self.config.lock().unwrap().room_id != c.room_id;
        self.mixer
            .lock()
            .unwrap()
            .sources
            .retain(|id, _| c.enabled && !changed && c.members.contains(id));
        let enabled = c.enabled;
        *self.config.lock().unwrap() = c;
        if changed || !enabled {
            self.mute()
        }
        if enabled && !self.running.swap(true, Ordering::SeqCst) {
            self.stop.store(false, Ordering::SeqCst);
            let this = self.clone();
            thread::Builder::new()
                .name("cyber-audio".into())
                .spawn(move || this.run())
                .map_err(|_| "音频线程不可用")?;
        }
        Ok(())
    }
    pub fn microphone(self: &Arc<Self>, on: bool) -> bool {
        let c = self.config.lock().unwrap().clone();
        if on && !c.enabled {
            return false;
        }
        if on && !self.running.load(Ordering::Relaxed) && self.configure(c).is_err() {
            return false;
        }
        self.microphone.store(on, Ordering::SeqCst);
        true
    }
    pub fn mute(&self) {
        self.microphone.store(false, Ordering::SeqCst)
    }
    pub fn stop(&self) {
        self.mute();
        self.config.lock().unwrap().enabled = false;
        self.mixer.lock().unwrap().sources.clear();
    }
    pub fn shutdown(&self) {
        self.stop();
        self.stop.store(true, Ordering::SeqCst)
    }
    pub fn receive(&self, p: &Packet, peer: Option<&str>) -> bool {
        let Ok(h) = p.fields() else { return false };
        if h.get("type") != Some(&"voice") {
            return false;
        }
        if h.get("codec") != Some(&CODEC) {
            return true;
        }
        let c = self.config.lock().unwrap();
        let from = peer.or_else(|| h.get("from").copied()).unwrap_or("");
        if !c.enabled
            || h.get("roomId") != Some(&c.room_id.as_str())
            || from == c.self_id
            || !c.members.iter().any(|id| id == from)
        {
            return true;
        }
        let Some((stream, seq, samples)) = decode(&p.body) else {
            return true;
        };
        let clock = u32::from_le_bytes(p.body[12..16].try_into().unwrap());
        let now = Instant::now();
        let mut mixer = self.mixer.lock().unwrap();
        let s = mixer.sources.entry(from.into()).or_insert_with(|| Source {
            stream,
            seq: seq.wrapping_sub(1),
            frames: VecDeque::new(),
            current: Vec::new(),
            offset: 0,
            retired: VecDeque::new(),
            anchor: now,
            clock,
            received: 0,
            late: 0,
        });
        if stream != s.stream {
            if s.retired.contains(&stream) {
                return true;
            }
            s.retired.push_back(s.stream);
            while s.retired.len() > 8 {
                s.retired.pop_front();
            }
            s.stream = stream;
            s.seq = seq.wrapping_sub(1);
            s.frames.clear();
            s.current.clear();
            s.offset = 0;
            s.anchor = now;
            s.clock = clock;
        }
        let ahead = seq.wrapping_sub(s.seq);
        if ahead == 0 || ahead > 0x7fff_ffff || s.frames.iter().any(|(n, _, _)| *n == seq) {
            return true;
        }
        let delta = clock.wrapping_sub(s.clock);
        if delta > 0x7fff_ffff {
            return true;
        }
        let expected = s.anchor + Duration::from_micros(delta as u64 * 1_000_000 / 16_000);
        s.received += 1;
        if now.saturating_duration_since(expected) > Duration::from_millis(200) {
            s.late += 1;
            return true;
        }
        // Re-anchor once a minute using the earlier of the sampling timeline and
        // actual arrival, bounding clock drift without hiding a stalled stream.
        if delta > 960_000 {
            s.anchor = expected.min(now);
            s.clock = clock;
        }
        let due = expected.min(now) + Duration::from_millis(40);
        let position = s
            .frames
            .iter()
            .position(|(n, _, _)| n.wrapping_sub(s.seq) > ahead)
            .unwrap_or(s.frames.len());
        s.frames.insert(position, (seq, due, samples));
        while s.frames.len() >= 6 {
            s.frames.pop_front();
        }
        true
    }
    fn status(&self, capture: bool, playing: bool, aec: bool, error: &str) {
        if let Some(s) = self.state.upgrade() {
            let backlog = s.network.queued_ms();
            let mut status = json!({"type":"voiceStatus","available":playing,"capture":capture,"playing":playing,"microphone":self.microphone.load(Ordering::Relaxed),"aec":aec,"aecMode":if aec{"windows-render-reference"}else{"unavailable"},"codec":CODEC,"queuedMs":backlog,"suggestedDirectLimit":if backlog>100{0}else{5},"error":error});
            if self.diagnostics {
                let mixer = self.mixer.lock().unwrap();
                status["playedFrames"] = json!(mixer.played_frames);
                status["outputPeak"] = json!(mixer.output_peak);
                status["peers"] = json!(mixer.sources.iter().map(|(id, source)| json!({"peerId":id,"stream":source.stream,"received":source.received,"late":source.late,"queued":source.frames.len()})).collect::<Vec<_>>());
            }
            s.event(status);
        }
    }
    fn transmit(&self, body: Vec<u8>) {
        let c = self.config.lock().unwrap().clone();
        if !c.enabled || !self.microphone.load(Ordering::Relaxed) {
            return;
        }
        let Some(s) = self.state.upgrade() else {
            return;
        };
        let mut relay = Vec::new();
        for id in c.members.iter().filter(|id| **id != c.self_id) {
            let p = Packet::new(
                64,
                format!(
                    "roomId:{}\nto:{}\ntype:voice\ncodec:{CODEC}\ndiscard:1\nmaxAgeMs:200\n",
                    c.room_id, id
                ),
                &body,
            );
            if !c.direct_targets.contains(id)
                || !s
                    .udp
                    .lock()
                    .unwrap()
                    .as_ref()
                    .is_some_and(|udp| udp.send(id, &p))
            {
                relay.push(id.as_str())
            }
        }
        if !relay.is_empty() {
            s.network.send(Packet::new(16,format!("op:201\nroomId:{}\nto:{}\ntype:voice\ncodec:{CODEC}\ndiscard:1\nmaxAgeMs:200\n",c.room_id,relay.join(",")),body));
        }
    }
    fn run(self: Arc<Self>) {
        let failed = Arc::new(AtomicBool::new(false));
        let output = output_stream(&self, failed.clone());
        let output = match output {
            Ok(s) => s,
            Err(e) => {
                self.mute();
                self.status(false, false, false, &e);
                self.running.store(false, Ordering::SeqCst);
                return;
            }
        };
        if output.play().is_err() {
            self.status(false, false, false, "扬声器不可用");
            self.running.store(false, Ordering::SeqCst);
            return;
        }
        let mut capture = None;
        let mut fallback: Option<(cpal::Stream, mpsc::Receiver<(Instant, Vec<i16>)>)> = None;
        let mut samples = VecDeque::new();
        let mut seq = 0u32;
        let mut clock = 0u32;
        let mut stream = 0u32;
        let mut sample_anchor = None;
        let mut last = Instant::now();
        let mut report = Instant::now();
        let mut error = String::new();
        let mut muted = true;
        while !self.stop.load(Ordering::Relaxed) {
            let on = self.microphone.load(Ordering::SeqCst);
            if on && muted {
                stream = OsRng.next_u32();
                seq = 0;
                clock = 0;
                sample_anchor = None;
                samples.clear();
                capture = Aec::open();
                error.clear();
                if capture.is_none() {
                    match input_stream(failed.clone()) {
                        Ok((s, r)) => {
                            if s.play().is_ok() {
                                fallback = Some((s, r));
                                error = "系统回声消除不可用，开麦时请使用耳机".into()
                            } else {
                                self.mute();
                                error = "麦克风启动失败".into()
                            }
                        }
                        Err(e) => {
                            self.mute();
                            error = e
                        }
                    }
                }
                last = Instant::now();
                report = Instant::now() - Duration::from_secs(3);
            }
            if !on && !muted {
                capture = None;
                fallback = None;
                samples.clear();
                report = Instant::now() - Duration::from_secs(3);
            }
            muted = !on;
            if let Some(aec) = capture.as_mut() {
                let mut data = [0i16; 3200];
                let n = aec.read(&mut data);
                if n < 0 || (n == 0 && last.elapsed() > Duration::from_secs(2)) {
                    capture = None;
                    match input_stream(failed.clone()) {
                        Ok((s, r)) if s.play().is_ok() => {
                            fallback = Some((s, r));
                            error = "系统回声消除无法采集，已降级为普通麦克风，请使用耳机".into();
                        }
                        _ => {
                            self.mute();
                            error = "麦克风采集不可用，请检查默认设备与隐私权限".into();
                        }
                    }
                } else if n > 0 {
                    last = Instant::now();
                    samples.extend(data[..n as usize].iter().copied());
                }
            }
            if let Some((_, rx)) = &fallback {
                while let Ok((at, frame)) = rx.try_recv() {
                    if at.elapsed() <= Duration::from_millis(200) {
                        samples.extend(frame)
                    }
                }
            }
            while samples.len() > 1600 {
                samples.drain(..320);
                clock = clock.wrapping_add(320);
                seq = seq.wrapping_add(1);
            }
            while samples.len() >= 320 {
                let at = Instant::now()
                    - Duration::from_micros((samples.len() - 320) as u64 * 1_000_000 / 16_000);
                if sample_anchor.is_none_or(|anchor| capture_discontinuity(anchor, clock, at)) {
                    // A device stall or dropped capture callbacks must not leave
                    // this stream permanently behind receivers' 200ms deadline.
                    stream = OsRng.next_u32();
                    seq = 0;
                    clock = 0;
                    sample_anchor = Some(at);
                }
                let frame = samples.drain(..320).collect::<Vec<_>>();
                self.transmit(encode(&frame, stream, seq, clock));
                seq = seq.wrapping_add(1);
                clock = clock.wrapping_add(320);
            }
            if failed.swap(false, Ordering::SeqCst) {
                self.mute();
                error = "音频设备已变化，请重新加入语音".into();
                self.status(false, false, false, &error);
                break;
            }
            if report.elapsed() > Duration::from_secs(2) {
                report = Instant::now();
                self.status(
                    capture.is_some() || fallback.is_some() || !on,
                    true,
                    capture.is_some(),
                    &error,
                )
            }
            if !self.config.lock().unwrap().enabled {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        drop(fallback);
        drop(capture);
        drop(output);
        self.mute();
        self.running.store(false, Ordering::SeqCst);
    }
}
fn output_stream(voice: &Arc<Voice>, failed: Arc<AtomicBool>) -> Result<cpal::Stream, String> {
    let device = cpal::default_host()
        .default_output_device()
        .ok_or("未找到扬声器")?;
    let config = device
        .default_output_config()
        .map_err(|_| "扬声器格式不可用")?;
    let format = config.sample_format();
    let config: cpal::StreamConfig = config.into();
    match format {
        cpal::SampleFormat::F32 => output::<f32>(&device, &config, voice.clone(), failed),
        cpal::SampleFormat::I16 => output::<i16>(&device, &config, voice.clone(), failed),
        cpal::SampleFormat::U16 => output::<u16>(&device, &config, voice.clone(), failed),
        _ => Err("扬声器采样格式不支持".into()),
    }
}
fn output<T: cpal::SizedSample + cpal::FromSample<f32>>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    voice: Arc<Voice>,
    failed: Arc<AtomicBool>,
) -> Result<cpal::Stream, String> {
    let channels = config.channels as usize;
    let rate = config.sample_rate.0;
    device
        .build_output_stream(
            config,
            move |data: &mut [T], _| {
                let mut mixer = voice.mixer.lock().unwrap();
                for frame in data.chunks_mut(channels) {
                    mixer.phase += 16000;
                    while mixer.phase >= rate {
                        mixer.phase -= rate;
                        mixer.value = mixer.sample()
                    }
                    let value = T::from_sample(mixer.value);
                    frame.fill(value);
                }
            },
            move |_| failed.store(true, Ordering::SeqCst),
            None,
        )
        .map_err(|_| "扬声器启动失败".into())
}
fn input_stream(
    failed: Arc<AtomicBool>,
) -> Result<(cpal::Stream, mpsc::Receiver<(Instant, Vec<i16>)>), String> {
    let device = cpal::default_host()
        .default_input_device()
        .ok_or("未找到麦克风，请检查Windows麦克风权限")?;
    let config = device
        .default_input_config()
        .map_err(|_| "麦克风格式不可用")?;
    let format = config.sample_format();
    let config: cpal::StreamConfig = config.into();
    let (tx, rx) = mpsc::sync_channel(5);
    let s = match format {
        cpal::SampleFormat::F32 => input::<f32>(&device, &config, tx, failed),
        cpal::SampleFormat::I16 => input::<i16>(&device, &config, tx, failed),
        cpal::SampleFormat::U16 => input::<u16>(&device, &config, tx, failed),
        _ => Err("麦克风采样格式不支持".into()),
    }?;
    Ok((s, rx))
}
fn input<T: cpal::SizedSample>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    tx: mpsc::SyncSender<(Instant, Vec<i16>)>,
    failed: Arc<AtomicBool>,
) -> Result<cpal::Stream, String>
where
    f32: cpal::FromSample<T>,
{
    let channels = config.channels as usize;
    let rate = config.sample_rate.0;
    let mut phase = 0u32;
    let mut frame = Vec::with_capacity(320);
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                for samples in data.chunks(channels) {
                    let mono =
                        samples.iter().map(|s| s.to_sample::<f32>()).sum::<f32>() / channels as f32;
                    phase += 16000;
                    while phase >= rate {
                        phase -= rate;
                        frame.push((mono.clamp(-1., 1.) * 32767.) as i16);
                        if frame.len() == 320 {
                            let _ = tx.try_send((
                                Instant::now(),
                                std::mem::replace(&mut frame, Vec::with_capacity(320)),
                            ));
                        }
                    }
                }
            },
            move |_| failed.store(true, Ordering::SeqCst),
            None,
        )
        .map_err(|_| "麦克风不可用，请允许桌面应用访问麦克风".into())
}
unsafe extern "C" {
    fn cyber_aec_open() -> *mut std::ffi::c_void;
    fn cyber_aec_read(handle: *mut std::ffi::c_void, samples: *mut i16, capacity: i32) -> i32;
    fn cyber_aec_close(handle: *mut std::ffi::c_void);
}
struct Aec(*mut std::ffi::c_void);
impl Aec {
    fn open() -> Option<Self> {
        let p = unsafe { cyber_aec_open() };
        (!p.is_null()).then_some(Self(p))
    }
    fn read(&mut self, b: &mut [i16]) -> i32 {
        unsafe { cyber_aec_read(self.0, b.as_mut_ptr(), b.len() as i32) }
    }
}
impl Drop for Aec {
    fn drop(&mut self) {
        unsafe { cyber_aec_close(self.0) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn voice() -> Arc<Voice> {
        let voice = Voice::new(Weak::new());
        *voice.config.lock().unwrap() = Config {
            room_id: "1".repeat(32),
            self_id: "2".repeat(32),
            members: vec!["3".repeat(32)],
            direct_targets: vec![],
            enabled: true,
            codec: CODEC.into(),
        };
        voice
    }
    fn packet(stream: u32, seq: u32, clock: u32) -> Packet {
        Packet::new(
            64,
            format!(
                "roomId:{}\nfrom:{}\ntype:voice\ncodec:{CODEC}\n",
                "1".repeat(32),
                "3".repeat(32)
            ),
            encode(&[900; 320], stream, seq, clock),
        )
    }
    #[test]
    fn capture_stalls_start_a_new_timeline_without_reanchoring_late_network_packets() {
        let start = Instant::now();
        assert!(!capture_discontinuity(
            start,
            320,
            start + Duration::from_millis(20)
        ));
        assert!(!capture_discontinuity(
            start,
            1600,
            start + Duration::from_millis(140)
        ));
        assert!(capture_discontinuity(
            start,
            1600,
            start + Duration::from_millis(500)
        ));
        let resumed = start + Duration::from_millis(500);
        assert!(!capture_discontinuity(
            resumed,
            320,
            resumed + Duration::from_millis(20)
        ));
        let voice = voice();
        voice.receive(&packet(1, 0, 0), None);
        voice
            .mixer
            .lock()
            .unwrap()
            .sources
            .get_mut(&"3".repeat(32))
            .unwrap()
            .anchor = start - Duration::from_secs(1);
        voice.receive(&packet(1, 1, 320), None);
        assert_eq!(
            voice.mixer.lock().unwrap().sources[&"3".repeat(32)]
                .frames
                .len(),
            1
        );
        voice.receive(&packet(2, 0, 0), None);
        voice.receive(&packet(2, 1, 320), None);
        let mixer = voice.mixer.lock().unwrap();
        assert_eq!(mixer.sources[&"3".repeat(32)].stream, 2);
        assert_eq!(mixer.sources[&"3".repeat(32)].frames.len(), 2);
    }
    #[test]
    fn disabled_audio_discards_decoded_samples_before_foreground() {
        let voice = voice();
        voice.receive(&packet(1, 0, 0), None);
        assert_eq!(voice.mixer.lock().unwrap().sources.len(), 1);
        let mut config = voice.config.lock().unwrap().clone();
        config.enabled = false;
        voice.configure(config).unwrap();
        assert!(voice.mixer.lock().unwrap().sources.is_empty());
        assert!(!voice.microphone(true));
    }
    #[test]
    fn voice_sources_reorder_deduplicate_and_reject_retired_streams() {
        let voice = voice();
        for n in [10, 12, 11, 11] {
            voice.receive(&packet(1, n, n * 320), None);
        }
        let peer = "3".repeat(32);
        assert_eq!(
            voice.mixer.lock().unwrap().sources[&peer]
                .frames
                .iter()
                .map(|f| f.0)
                .collect::<Vec<_>>(),
            vec![10, 11, 12]
        );
        voice.receive(&packet(2, 0, 0), None);
        voice.receive(&packet(1, 13, 4160), None);
        let mixer = voice.mixer.lock().unwrap();
        assert_eq!(mixer.sources[&peer].stream, 2);
        assert_eq!(mixer.sources[&peer].frames.len(), 1);
    }
    #[test]
    fn voice_deadline_uses_sample_clock_not_new_arrival() {
        let voice = voice();
        voice.receive(&packet(1, 0, 0), None);
        voice
            .mixer
            .lock()
            .unwrap()
            .sources
            .get_mut(&"3".repeat(32))
            .unwrap()
            .anchor = Instant::now() - Duration::from_secs(1);
        voice.receive(&packet(1, 1, 320), None);
        assert_eq!(
            voice.mixer.lock().unwrap().sources[&"3".repeat(32)]
                .frames
                .len(),
            1
        );
    }
    #[test]
    fn voice_rejects_wrong_room_source_and_malformed_frame() {
        let voice = voice();
        let mut p = packet(1, 0, 0);
        assert!(voice.receive(&p, Some(&"4".repeat(32))));
        assert!(voice.mixer.lock().unwrap().sources.is_empty());
        p.control = String::from_utf8(p.control)
            .unwrap()
            .replace(&"1".repeat(32), &"5".repeat(32))
            .into_bytes();
        voice.receive(&p, None);
        assert!(voice.mixer.lock().unwrap().sources.is_empty());
        let mut body = packet(1, 0, 0).body;
        body[18] = 89;
        assert!(decode(&body).is_none());
        body[18] = 0;
        body[19] = 1;
        assert!(decode(&body).is_none());
    }
    #[test]
    fn shared_crv1_vectors() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../scripts/fixtures/voice-crv1.json")).unwrap();
        for v in fixture["vectors"].as_array().unwrap() {
            let hex = v["packetHex"].as_str().unwrap();
            let bytes = (0..hex.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
                .collect::<Vec<_>>();
            let expected = v["decoded"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s.as_i64().unwrap() as i16)
                .collect::<Vec<_>>();
            let (stream, seq, decoded) = decode(&bytes).unwrap();
            assert_eq!(stream, v["stream"].as_u64().unwrap() as u32);
            assert_eq!(seq, v["sequence"].as_u64().unwrap() as u32);
            assert_eq!(decoded, expected);
            if v["initialIndex"].as_u64() == Some(0) {
                let pcm = v["pcm"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|s| s.as_i64().unwrap() as i16)
                    .collect::<Vec<_>>();
                assert_eq!(
                    encode(&pcm, stream, seq, v["sampleClock"].as_u64().unwrap() as u32),
                    bytes
                );
            }
        }
    }
}
