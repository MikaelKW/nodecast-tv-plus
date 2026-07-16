/**
 * Accessible password visibility controls shared by authentication forms.
 */
(function initializePasswordVisibilityModule() {
    const concealedIcon = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon" aria-hidden="true">
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"></path>
            <circle cx="12" cy="12" r="3"></circle>
        </svg>`;
    const visibleIcon = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon" aria-hidden="true">
            <path d="M3 3l18 18"></path>
            <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"></path>
            <path d="M9.9 4.2A10.8 10.8 0 0 1 12 4c6.5 0 10 8 10 8a17.6 17.6 0 0 1-2.1 3.2"></path>
            <path d="M6.6 6.6C3.6 8.6 2 12 2 12s3.5 8 10 8a10.5 10.5 0 0 0 4.1-.8"></path>
        </svg>`;
    const initializedForms = new WeakSet();

    function setVisibility(input, button, visible) {
        input.type = visible ? 'text' : 'password';
        button.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
        button.setAttribute('title', visible ? 'Hide password' : 'Show password');
        button.setAttribute('aria-pressed', String(visible));
        button.innerHTML = visible ? visibleIcon : concealedIcon;
    }

    function concealWithin(root = document) {
        root.querySelectorAll('.password-input-wrapper').forEach(wrapper => {
            const input = wrapper.querySelector('input[data-password-toggle]');
            const button = wrapper.querySelector('.password-visibility-toggle');
            if (input && button) setVisibility(input, button, false);
        });
    }

    function initialize(root = document) {
        root.querySelectorAll('input[data-password-toggle]').forEach(input => {
            if (input.dataset.passwordToggleReady === 'true') return;

            const wrapper = document.createElement('div');
            wrapper.className = 'password-input-wrapper';
            input.parentNode.insertBefore(wrapper, input);
            wrapper.appendChild(input);

            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'password-visibility-toggle';
            button.setAttribute('aria-controls', input.id);
            setVisibility(input, button, false);
            button.addEventListener('click', () => {
                setVisibility(input, button, input.type === 'password');
            });
            wrapper.appendChild(button);
            input.dataset.passwordToggleReady = 'true';

            const form = input.closest('form');
            if (form && !initializedForms.has(form)) {
                initializedForms.add(form);
                form.addEventListener('reset', () => {
                    setTimeout(() => concealWithin(form), 0);
                });
            }
        });
    }

    window.PasswordVisibility = { initialize, concealWithin };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => initialize(), { once: true });
    } else {
        initialize();
    }
})();
