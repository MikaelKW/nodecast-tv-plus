class MfaOnboardingPage {
    constructor(app) {
        this.app = app;
        this.page = document.getElementById('page-mfa-onboarding');
        this.dialog = document.getElementById('mfa-onboarding-skip-dialog');

        document.getElementById('mfa-onboarding-continue')?.addEventListener('click', () => this.continueToEnrollment());
        document.getElementById('mfa-onboarding-skip')?.addEventListener('click', () => this.openSkipDialog());
        document.getElementById('mfa-onboarding-skip-back')?.addEventListener('click', () => this.closeSkipDialog());
        document.getElementById('mfa-onboarding-skip-confirm')?.addEventListener('click', () => this.finishSkip());
        this.dialog?.addEventListener('click', event => {
            if (event.target === this.dialog) this.closeSkipDialog();
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !this.dialog?.classList.contains('hidden')) this.closeSkipDialog();
        });
    }

    show() {
        document.body.classList.add('mfa-onboarding-active');
        document.getElementById('mfa-onboarding-heading')?.focus({ preventScroll: true });
    }

    hide() {
        document.body.classList.remove('mfa-onboarding-active');
        this.closeSkipDialog(false);
    }

    continueToEnrollment() {
        NodeCastOnboarding.completeMfaPrompt();
        this.app.pages.account.requestEnrollmentOnNextShow();
        this.app.navigateTo('account', true);
    }

    openSkipDialog() {
        if (!this.dialog) return;
        this.dialog.classList.remove('hidden');
        document.getElementById('mfa-onboarding-skip-confirm')?.focus();
    }

    closeSkipDialog(restoreFocus = true) {
        if (!this.dialog) return;
        this.dialog.classList.add('hidden');
        if (restoreFocus) document.getElementById('mfa-onboarding-skip')?.focus();
    }

    finishSkip() {
        NodeCastOnboarding.completeMfaPrompt();
        this.closeSkipDialog(false);
        this.app.navigateTo('home', true);
    }
}
