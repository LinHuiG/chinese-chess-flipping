#include <windows.h>
#include <wtsapi32.h>

// Query the current Windows session, without opening or changing its desktop.
// Unknown status preserves the previous state on the Rust side.
extern "C" int cyber_session_locked() {
    LPWSTR raw = nullptr;
    DWORD bytes = 0;
    if (!WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION,
            WTSSessionInfoEx, &raw, &bytes)) return -1;
    int locked = -1;
    if (bytes >= sizeof(WTSINFOEXW)) {
        auto* info = reinterpret_cast<WTSINFOEXW*>(raw);
        if (info->Level == 1) {
            const auto& session = info->Data.WTSInfoExLevel1;
            if (session.SessionState != WTSActive || session.SessionFlags == WTS_SESSIONSTATE_LOCK) locked = 1;
            else if (session.SessionFlags == WTS_SESSIONSTATE_UNLOCK) locked = 0;
        }
    }
    WTSFreeMemory(raw);
    return locked;
}
