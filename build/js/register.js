document.getElementById('registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value.trim();
    const confirmPassword = document.getElementById('confirmPassword').value.trim();
    
    // Clear previous error messages
    document.getElementById('errorMessage').textContent = '';
    
    // Validate fields
    if (!username || !password || !confirmPassword) {
        document.getElementById('errorMessage').textContent = 'All fields are required.';
        return;
    }
    
    if (password !== confirmPassword) {
        document.getElementById('errorMessage').textContent = 'Passwords do not match.';
        return;
    }
    
    try {
        const response = await fetch('/api/register', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                username,
                password,
                confirmPassword,
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            // Redirect to login page with success message
            window.location.href = '/login.html?registered=true';
        } else {
            // Display error message
            document.getElementById('errorMessage').textContent = data.message || 'Registration failed.';
        }
    } catch (error) {
        console.error('Registration error:', error);
        document.getElementById('errorMessage').textContent = 'Error during registration. Please try again.';
    }
});