// Windows Voice Capture DSP source mode captures the microphone and the default
// render endpoint together, so the reference includes WebView movie audio.
#include <windows.h>
#include <dmo.h>
#include <mediaobj.h>
#include <wmcodecdsp.h>
#include <propsys.h>
#include <uuids.h>
#include <new>

class OutputBuffer final : public IMediaBuffer {
    BYTE* data; DWORD capacity, length = 0;
public:
    OutputBuffer(short* output, int samples): data(reinterpret_cast<BYTE*>(output)), capacity(samples * 2) {}
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** result) override {
        if (!result) return E_POINTER;
        *result = nullptr;
        if (iid == IID_IUnknown || iid == IID_IMediaBuffer) { *result = static_cast<IMediaBuffer*>(this); return S_OK; }
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return 2; }
    ULONG STDMETHODCALLTYPE Release() override { return 1; }
    HRESULT STDMETHODCALLTYPE SetLength(DWORD value) override { if (value > capacity) return E_INVALIDARG; length = value; return S_OK; }
    HRESULT STDMETHODCALLTYPE GetMaxLength(DWORD* value) override { if (!value) return E_POINTER; *value = capacity; return S_OK; }
    HRESULT STDMETHODCALLTYPE GetBufferAndLength(BYTE** bytes, DWORD* size) override { if (bytes) *bytes = data; if (size) *size = length; return S_OK; }
    int samples() const { return static_cast<int>(length / 2); }
};
struct Capture { IMediaObject* dmo = nullptr; bool com = false; ~Capture() { if (dmo) { dmo->FreeStreamingResources(); dmo->Release(); } if (com) CoUninitialize(); } };
extern "C" void* cyber_aec_open() {
    auto* c = new (std::nothrow) Capture();
    if (!c) return nullptr;
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    c->com = SUCCEEDED(hr);
    if (FAILED(hr)) { delete c; return nullptr; }
    hr = CoCreateInstance(CLSID_CWMAudioAEC, nullptr, CLSCTX_INPROC_SERVER, IID_IMediaObject, reinterpret_cast<void**>(&c->dmo));
    IPropertyStore* properties = nullptr;
    if (SUCCEEDED(hr)) hr = c->dmo->QueryInterface(IID_PPV_ARGS(&properties));
    if (SUCCEEDED(hr)) {
        PROPVARIANT mode{}; mode.vt = VT_I4; mode.lVal = SINGLE_CHANNEL_AEC;
        hr = properties->SetValue(MFPKEY_WMAAECMA_SYSTEM_MODE, mode);
        PROPVARIANT source{}; source.vt = VT_BOOL; source.boolVal = VARIANT_TRUE;
        if (SUCCEEDED(hr)) hr = properties->SetValue(MFPKEY_WMAAECMA_DMO_SOURCE_MODE, source);
        // Defaults select the same default render endpoint used by WebView/CPAL.
        properties->Release();
    }
    WAVEFORMATEX format{WAVE_FORMAT_PCM, 1, 16000, 32000, 2, 16, 0};
    DMO_MEDIA_TYPE type{};
    type.majortype = MEDIATYPE_Audio; type.subtype = MEDIASUBTYPE_PCM;
    type.bFixedSizeSamples = TRUE; type.lSampleSize = 2; type.formattype = FORMAT_WaveFormatEx;
    type.cbFormat = sizeof(format); type.pbFormat = reinterpret_cast<BYTE*>(&format);
    if (SUCCEEDED(hr)) hr = c->dmo->SetOutputType(0, &type, 0);
    if (SUCCEEDED(hr)) hr = c->dmo->AllocateStreamingResources();
    if (FAILED(hr)) { delete c; return nullptr; }
    return c;
}
extern "C" int cyber_aec_read(void* handle, short* samples, int capacity) {
    if (!handle || !samples || capacity < 320) return -1;
    auto* c = static_cast<Capture*>(handle);
    OutputBuffer buffer(samples, capacity);
    DMO_OUTPUT_DATA_BUFFER output{}; output.pBuffer = &buffer;
    DWORD status = 0;
    HRESULT hr = c->dmo->ProcessOutput(0, 1, &output, &status);
    if (FAILED(hr)) return -1;
    return hr == S_FALSE ? 0 : buffer.samples();
}
extern "C" void cyber_aec_close(void* handle) { delete static_cast<Capture*>(handle); }
