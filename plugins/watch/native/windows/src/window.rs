use std::{
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};
extern "C" {
    fn cyber_media_ui_init();
    fn cyber_media_ui_pump();
}
#[derive(Clone)]
pub struct Window {
    parent: isize,
    scale: Arc<Mutex<f64>>,
    queue: mpsc::Sender<Box<dyn FnOnce() + Send>>,
}
pub struct Hwnd(pub isize);
impl Window {
    pub fn new(parent: isize, scale: f64) -> Self {
        let (tx, rx) = mpsc::channel::<Box<dyn FnOnce() + Send>>();
        std::thread::spawn(move || {
            unsafe {
                cyber_media_ui_init();
            }
            loop {
                match rx.recv_timeout(Duration::from_millis(5)) {
                    Ok(task) => task(),
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(_) => {}
                }
                unsafe {
                    cyber_media_ui_pump();
                }
            }
        });
        Self {
            parent,
            scale: Arc::new(Mutex::new(scale)),
            queue: tx,
        }
    }
    pub fn get_webview_window(&self, _: &str) -> Option<Self> {
        Some(self.clone())
    }
    pub fn hwnd(&self) -> Result<Hwnd, String> {
        Ok(Hwnd(self.parent))
    }
    pub fn scale_factor(&self) -> Result<f64, String> {
        Ok(*self.scale.lock().unwrap())
    }
    pub fn set_scale(&self, value: f64) {
        if value.is_finite() && value > 0. && value < 10. {
            *self.scale.lock().unwrap() = value;
        }
    }
    pub fn run_on_main_thread(&self, f: impl FnOnce() + Send + 'static) -> Result<(), String> {
        self.queue
            .send(Box::new(f))
            .map_err(|_| "UI thread closed".into())
    }
}
