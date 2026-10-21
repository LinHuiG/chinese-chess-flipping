#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <d2d1_1.h>
#include <dwrite.h>
#include <dcomp.h>
#include <wrl/client.h>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <deque>
#include <string>

using Microsoft::WRL::ComPtr;
namespace {
std::atomic<bool> interacted{false};
constexpr wchar_t WINDOW_CLASS[] = L"CyberRoomMediaViewport";
constexpr float WIDTH = 1280.f, HEIGHT = 720.f;
struct Bullet {
    std::wstring id;
    ULONGLONG start;
    ComPtr<IDCompositionVisual> visual;
};
// All objects are used on Tauri's UI thread. DWM advances the animation after
// one Commit; no application timer, ASS parsing or video-frame redraw is needed.
struct Viewport {
    ComPtr<ID3D11Device> d3d;
    ComPtr<ID2D1Factory1> factory;
    ComPtr<ID2D1Device> d2d;
    ComPtr<ID2D1DeviceContext> context;
    ComPtr<IDWriteFactory> write;
    ComPtr<IDCompositionDevice> composition;
    ComPtr<IDCompositionTarget> target;
    ComPtr<IDCompositionVisual> root;
    ComPtr<IDCompositionScaleTransform> scale;
    std::deque<Bullet> bullets;
    int width = 0, height = 0;
    unsigned lane = 0;
    bool ready = false;

    bool initialize(HWND hwnd) {
        HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION, &d3d, nullptr, nullptr);
        if (FAILED(hr)) hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION, &d3d, nullptr, nullptr);
        ComPtr<IDXGIDevice> dxgi;
        if (FAILED(hr) || FAILED(d3d.As(&dxgi))) return false;
        if (FAILED(D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED,
                __uuidof(ID2D1Factory1), nullptr, reinterpret_cast<void**>(factory.GetAddressOf()))) ||
            FAILED(factory->CreateDevice(dxgi.Get(), &d2d)) ||
            FAILED(d2d->CreateDeviceContext(D2D1_DEVICE_CONTEXT_OPTIONS_NONE, &context)) ||
            FAILED(DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory),
                reinterpret_cast<IUnknown**>(write.GetAddressOf()))) ||
            FAILED(DCompositionCreateDevice(dxgi.Get(), __uuidof(IDCompositionDevice),
                reinterpret_cast<void**>(composition.GetAddressOf()))) ||
            FAILED(composition->CreateTargetForHwnd(hwnd, TRUE, &target)) ||
            FAILED(composition->CreateVisual(&root)) ||
            FAILED(composition->CreateScaleTransform(&scale)) ||
            FAILED(root->SetTransform(scale.Get())) || FAILED(target->SetRoot(root.Get()))) return false;
        ready = true;
        RECT rectangle{};
        GetClientRect(hwnd, &rectangle);
        resize(rectangle.right, rectangle.bottom);
        return true;
    }
    void resize(int w, int h) {
        if (!ready || (w == width && h == height)) return;
        width = w; height = h;
        scale->SetScaleX(static_cast<float>(w) / WIDTH);
        scale->SetScaleY(static_cast<float>(h) / HEIGHT);
        composition->Commit();
    }
    void clear() {
        if (!ready) return;
        root->RemoveAllVisuals();
        bullets.clear();
        composition->Commit();
    }
    bool add(const wchar_t* id, const wchar_t* text) {
        if (!ready || !text || !*text) return false;
        auto now = GetTickCount64();
        while (!bullets.empty() && (now - bullets.front().start >= 8000 || bullets.size() >= 30)) {
            root->RemoveVisual(bullets.front().visual.Get());
            bullets.pop_front();
        }
        for (const auto& bullet : bullets) if (bullet.id == id) return true;
        ComPtr<IDWriteTextFormat> format;
        ComPtr<IDWriteTextLayout> layout;
        if (FAILED(write->CreateTextFormat(L"Segoe UI", nullptr, DWRITE_FONT_WEIGHT_SEMI_BOLD,
                DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL, 27.f, L"zh-CN", &format))) return false;
        format->SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
        if (FAILED(write->CreateTextLayout(text, static_cast<UINT32>(wcslen(text)), format.Get(),
                7000.f, 80.f, &layout))) return false;
        DWRITE_TEXT_METRICS metrics{};
        if (FAILED(layout->GetMetrics(&metrics))) return false;
        // Rasterize once at 2x to retain readable glyphs on high-DPI/fullscreen
        // windows. Position/scale remain floating point in the compositor.
        const float raster = d3d->GetFeatureLevel() >= D3D_FEATURE_LEVEL_11_0 ? 2.f : 1.f;
        const float textWidth = std::min(7000.f, std::ceil(metrics.widthIncludingTrailingWhitespace) + 6.f);
        const UINT pixelWidth = static_cast<UINT>(std::ceil(textWidth * raster));
        const UINT pixelHeight = static_cast<UINT>(std::ceil((metrics.height + 6.f) * raster));
        ComPtr<IDCompositionSurface> surface;
        ComPtr<IDXGISurface> dxgiSurface;
        POINT offset{};
        if (FAILED(composition->CreateSurface(pixelWidth, pixelHeight, DXGI_FORMAT_B8G8R8A8_UNORM,
                DXGI_ALPHA_MODE_PREMULTIPLIED, &surface)) ||
            FAILED(surface->BeginDraw(nullptr, __uuidof(IDXGISurface),
                reinterpret_cast<void**>(dxgiSurface.GetAddressOf()), &offset))) return false;
        ComPtr<ID2D1Bitmap1> bitmap;
        auto properties = D2D1::BitmapProperties1(D2D1_BITMAP_OPTIONS_TARGET | D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
            D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM, D2D1_ALPHA_MODE_PREMULTIPLIED));
        HRESULT hr = context->CreateBitmapFromDxgiSurface(dxgiSurface.Get(), &properties, &bitmap);
        if (SUCCEEDED(hr)) {
            context->SetTarget(bitmap.Get());
            context->BeginDraw();
            context->SetTransform(D2D1::Matrix3x2F::Identity());
            context->PushAxisAlignedClip(D2D1::RectF(static_cast<float>(offset.x), static_cast<float>(offset.y),
                static_cast<float>(offset.x + pixelWidth), static_cast<float>(offset.y + pixelHeight)), D2D1_ANTIALIAS_MODE_ALIASED);
            context->Clear(D2D1::ColorF(0, 0.f));
            context->SetTransform(D2D1::Matrix3x2F::Scale(raster, raster) *
                D2D1::Matrix3x2F::Translation(static_cast<float>(offset.x), static_cast<float>(offset.y)));
            context->SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
            ComPtr<ID2D1SolidColorBrush> black, white;
            hr = context->CreateSolidColorBrush(D2D1::ColorF(0.f, 0.f, 0.f, .85f), &black);
            if (SUCCEEDED(hr)) hr = context->CreateSolidColorBrush(D2D1::ColorF(D2D1::ColorF::White), &white);
            if (SUCCEEDED(hr)) {
                for (const auto& p : {D2D1::Point2F(1.f, 2.f), D2D1::Point2F(3.f, 2.f),
                        D2D1::Point2F(2.f, 1.f), D2D1::Point2F(2.f, 3.f)})
                    context->DrawTextLayout(p, layout.Get(), black.Get());
                context->DrawTextLayout(D2D1::Point2F(2.f, 2.f), layout.Get(), white.Get());
            }
            context->PopAxisAlignedClip();
            HRESULT end = context->EndDraw();
            context->SetTarget(nullptr);
            if (SUCCEEDED(hr)) hr = end;
        }
        HRESULT end = surface->EndDraw();
        if (FAILED(hr) || FAILED(end)) return false;
        ComPtr<IDCompositionVisual> visual;
        ComPtr<IDCompositionScaleTransform> textScale;
        ComPtr<IDCompositionAnimation> movement;
        if (FAILED(composition->CreateVisual(&visual)) ||
            FAILED(composition->CreateScaleTransform(&textScale)) ||
            FAILED(textScale->SetScaleX(1.f / raster)) || FAILED(textScale->SetScaleY(1.f / raster)) ||
            FAILED(visual->SetTransform(textScale.Get())) || FAILED(visual->SetContent(surface.Get())) ||
            FAILED(composition->CreateAnimation(&movement)) ||
            FAILED(movement->AddCubic(0., WIDTH, -(WIDTH + textWidth) / 8.f, 0.f, 0.f)) ||
            FAILED(movement->End(8., -textWidth)) || FAILED(visual->SetOffsetX(movement.Get())) ||
            FAILED(visual->SetOffsetY(35.f + static_cast<float>((lane++) % 5) * 42.f)) ||
            FAILED(root->AddVisual(visual.Get(), TRUE, nullptr))) return false;
        if (FAILED(composition->Commit())) {
            root->RemoveVisual(visual.Get());
            return false;
        }
        bullets.push_back({id, now, std::move(visual)});
        return true;
    }
};
Viewport* viewport(HWND hwnd) {
    return reinterpret_cast<Viewport*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
}
LRESULT CALLBACK window_proc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam) {
    if (message == WM_NCCREATE) {
        auto* state = new Viewport();
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(state));
    }
    auto* state = viewport(hwnd);
    if (message == WM_SIZE && state) state->resize(LOWORD(lparam), HIWORD(lparam));
    if (message == WM_NCDESTROY) {
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
        delete state;
    }
    // This viewport and its overlays must not steal keyboard focus from the
    // WebView controls. It also leaves scrolling/click gestures to the parent.
    if (message == WM_MOUSEMOVE || message == WM_LBUTTONUP) interacted.store(true, std::memory_order_relaxed);
    if (message == WM_MOUSEACTIVATE) return MA_NOACTIVATE;
    return DefWindowProcW(hwnd, message, wparam, lparam);
}
}
extern "C" void* cyber_media_window_create(void* parent) {
    WNDCLASSW type{};
    type.lpfnWndProc = window_proc; type.hInstance = GetModuleHandleW(nullptr); type.lpszClassName = WINDOW_CLASS;
    RegisterClassW(&type);
    HWND hwnd = CreateWindowExW(WS_EX_NOACTIVATE, WINDOW_CLASS, L"", WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
        0, 0, 1, 1, static_cast<HWND>(parent), nullptr, type.hInstance, nullptr);
    if (hwnd) viewport(hwnd)->initialize(hwnd);
    return hwnd;
}
extern "C" int cyber_media_danmaku_supported(void* window) {
    auto* state = viewport(static_cast<HWND>(window));
    return state && state->ready;
}
extern "C" int cyber_media_danmaku_add(void* window, const wchar_t* id, const wchar_t* text) {
    auto* state = viewport(static_cast<HWND>(window));
    return state && state->add(id, text);
}
extern "C" void cyber_media_danmaku_clear(void* window) {
    if (auto* state = viewport(static_cast<HWND>(window))) state->clear();
}
extern "C" void cyber_media_window_bounds(void* window, int x, int y, int width, int height, int clip_height, int visible, int ex, int ey, int ew, int eh) {
    HRGN region=CreateRectRgn(0,0,width,std::clamp(clip_height,0,height));
    if(ew>0 && eh>0) { HRGN hole=CreateRectRgn(ex,ey,ex+ew,ey+eh); CombineRgn(region,region,hole,RGN_DIFF); DeleteObject(hole); }
    SetWindowRgn(static_cast<HWND>(window),region,TRUE);
    SetWindowPos(static_cast<HWND>(window), HWND_TOP, x, y, width, height,
        SWP_NOACTIVATE | (visible ? SWP_SHOWWINDOW : SWP_HIDEWINDOW));
}
extern "C" void cyber_media_window_hide(void* window) { ShowWindow(static_cast<HWND>(window), SW_HIDE); }
extern "C" void cyber_media_window_visible(void* window) {
    SetWindowPos(static_cast<HWND>(window), HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
}
extern "C" void cyber_media_window_destroy(void* window) { DestroyWindow(static_cast<HWND>(window)); }

extern "C" int cyber_media_interaction(void* window) {
    // mpv can own a child HWND, whose mouse messages do not reach our WndProc.
    // Sample on the existing player tick, restricted to the foreground viewport.
    static thread_local POINT previous{};
    static thread_local bool pressed = false;
    POINT point{}; GetCursorPos(&point);
    bool down = (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0;
    bool changed = point.x != previous.x || point.y != previous.y || (down && !pressed);
    previous = point; pressed = down;
    HWND hwnd = static_cast<HWND>(window), hit = WindowFromPoint(point);
    bool within = hwnd && IsWindowVisible(hwnd) && GetAncestor(hwnd, GA_ROOT) == GetForegroundWindow()
        && (hit == hwnd || IsChild(hwnd, hit));
    return interacted.exchange(false, std::memory_order_relaxed) || (changed && within) ? 1 : 0;
}
extern "C" void cyber_media_ui_init() { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2); }
extern "C" void cyber_media_ui_pump() { MSG msg; while(PeekMessageW(&msg,nullptr,0,0,PM_REMOVE)){TranslateMessage(&msg);DispatchMessageW(&msg);} }
