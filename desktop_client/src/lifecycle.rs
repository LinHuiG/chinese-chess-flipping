// Desktop focus is not visibility: switching apps or opening a system popup
// must not pause a room or replay its recovery sequence.
#[derive(Default)]
pub struct Visibility {
    background: bool,
    locked: bool,
}
impl Visibility {
    pub fn update(&mut self, minimized: bool, visible: bool, locked: Option<bool>) -> Option<bool> {
        if let Some(locked) = locked {
            self.locked = locked;
        }
        let background = minimized || !visible || self.locked;
        if self.background == background {
            return None;
        }
        self.background = background;
        Some(background)
    }
    pub fn background(&self) -> bool {
        self.background
    }
}
unsafe extern "C" {
    fn cyber_session_locked() -> i32;
}
pub fn session_locked() -> Option<bool> {
    match unsafe { cyber_session_locked() } {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn focus_popups_do_not_change_visible_desktop_lifecycle() {
        let mut state = Visibility::default();
        // Queries caused by blur, a popup, and refocus all see the same visible
        // non-minimized window and must produce no foreground replay.
        for _ in 0..4 {
            assert_eq!(state.update(false, true, Some(false)), None);
        }
        assert_eq!(state.update(true, true, Some(false)), Some(true));
        assert_eq!(state.update(true, true, Some(false)), None);
        assert_eq!(state.update(false, true, Some(false)), Some(false));
        assert_eq!(state.update(false, true, Some(false)), None);
    }
    #[test]
    fn hidden_and_locked_remain_background_until_both_clear() {
        let mut state = Visibility::default();
        assert_eq!(state.update(false, false, Some(false)), Some(true));
        assert_eq!(state.update(false, true, Some(true)), None);
        assert_eq!(state.update(false, true, None), None);
        assert!(state.background());
        assert_eq!(state.update(false, true, Some(false)), Some(false));
    }
}
