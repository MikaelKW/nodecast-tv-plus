document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;

    try {
        await API.request('POST', '/auth/login', { username, password });
        window.location.href = '/';
    } catch (err) {
        document.getElementById('login-error').textContent = 'Login failed: ' + err.message;
    }
});
