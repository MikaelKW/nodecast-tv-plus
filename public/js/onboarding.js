(function initializeOnboardingState(global) {
    const MFA_PENDING_KEY = 'nodecast.mfa-onboarding.pending';

    function readPending() {
        try {
            return global.sessionStorage.getItem(MFA_PENDING_KEY) === 'true';
        } catch {
            return false;
        }
    }

    function markMfaPending() {
        try {
            global.sessionStorage.setItem(MFA_PENDING_KEY, 'true');
            return true;
        } catch {
            return false;
        }
    }

    function completeMfaPrompt() {
        try {
            global.sessionStorage.removeItem(MFA_PENDING_KEY);
        } catch {
            // Storage can be unavailable in restricted browser contexts. The
            // onboarding prompt must never prevent access to the application.
        }
    }

    global.NodeCastOnboarding = Object.freeze({
        isMfaPending: readPending,
        markMfaPending,
        completeMfaPrompt
    });
})(window);
