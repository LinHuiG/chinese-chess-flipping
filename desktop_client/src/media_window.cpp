#define WIN32_LEAN_AND_MEAN
#include <windows.h>
// All calls run on Tauri's UI thread. The libmpv video window is a child of this
// viewport, so HTML dialogs can temporarily hide the complete native subtree.
extern "C" void* cyber_media_window_create(void* parent) {
    return CreateWindowExW(WS_EX_NOACTIVATE, L"STATIC", L"", WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
        0, 0, 1, 1, static_cast<HWND>(parent), nullptr, GetModuleHandleW(nullptr), nullptr);
}
extern "C" void cyber_media_window_bounds(void* window, int x, int y, int width, int height, int visible) {
    HWND hwnd = static_cast<HWND>(window);
    SetWindowPos(hwnd, HWND_TOP, x, y, width, height, SWP_NOACTIVATE | (visible ? SWP_SHOWWINDOW : SWP_HIDEWINDOW));
}
extern "C" void cyber_media_window_hide(void* window) { ShowWindow(static_cast<HWND>(window), SW_HIDE); }
extern "C" void cyber_media_window_visible(void* window) {
    SetWindowPos(static_cast<HWND>(window), HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
}
extern "C" void cyber_media_window_destroy(void* window) { DestroyWindow(static_cast<HWND>(window)); }
