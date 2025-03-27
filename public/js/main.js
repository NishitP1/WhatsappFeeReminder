// Get elements safely
const getEl = (id) => document.getElementById(id) || null;

// Connect to Socket.io
const socket = io({
    auth: {
        token: localStorage.getItem('authToken')
    }
});

// Add these selectors at the top
const messageTemplateForm = getEl('messageTemplateForm');
const messageTemplateEl = getEl('messageTemplate');
const sendRemindersBtn = getEl('sendRemindersBtn');

function getAuthHeaders(includeJson = true) {
    const token = localStorage.getItem('authToken');
    if (!token) {
        console.error('No auth token found');
        return {};
    }

    const headers = {
        Authorization: `Bearer ${token}`
    };

    if (includeJson) {
        headers["Content-Type"] = "application/json";
    }

    return headers;
}

// Listen for QR Code event
socket.on('qrCode', (data) => {
    console.log("Received QR Code event", data);
    
    if (qrCodeContainerEl && qrCodeEl) {
        qrCodeContainerEl.classList.remove('d-none'); // Show QR container
        qrCodeEl.src = data.qrCodeDataURL; // Set QR code image
    }
});

// Listen for WhatsApp status updates
socket.on('whatsappStatus', (data) => {
    console.log("WhatsApp Status:", data);

    if (whatsappStatusEl) {
        if (data.ready) {
            whatsappStatusEl.className = "alert alert-success";
            whatsappStatusEl.textContent = "WhatsApp Connected";
            qrCodeContainerEl?.classList.add('d-none'); // Hide QR when connected
        } else {
            whatsappStatusEl.className = "alert alert-danger";
            whatsappStatusEl.textContent = "WhatsApp Not Connected";
        }
    }
});

const whatsappStatusEl = getEl('whatsappStatus');
const qrCodeContainerEl = getEl('qrCodeContainer');
const qrCodeEl = getEl('qrCode');
const connectWhatsAppBtn = getEl('connectWhatsApp');
const disconnectWhatsAppBtn = getEl('disconnectWhatsApp');
const uploadFormEl = getEl('uploadForm');
const logoutBtn = document.querySelector('.btn-light');

// Initialize the app
document.addEventListener('DOMContentLoaded', () => {
    checkAuth();

    // Load saved template
    fetch('/api/config')
        .then(response => response.json())
        .then(config => {
            if (messageTemplateEl) {
                messageTemplateEl.value = config.messageTemplate;
            }
        });

    if (connectWhatsAppBtn) {
        connectWhatsAppBtn.addEventListener('click', () => {
            socket.emit('initializeWhatsApp');
            updateWhatsAppConnectionStatus('Initializing WhatsApp...', 'info');
            connectWhatsAppBtn.disabled = true;
        });
    }

    if (disconnectWhatsAppBtn) {
        disconnectWhatsAppBtn.addEventListener('click', () => {
            if (confirm('Are you sure you want to disconnect WhatsApp?')) {
                socket.emit('disconnectWhatsApp');
                updateWhatsAppConnectionStatus('Disconnecting WhatsApp...', 'warning');
            }
        });
    }

    if (uploadFormEl) {
        uploadFormEl.addEventListener('submit', async (e) => {
            e.preventDefault();

            const fileInput = document.getElementById('excelFile');
            if (!fileInput.files[0]) {
                alert('Please select an Excel file');
                return;
            }

            const formData = new FormData();
            formData.append('excelFile', fileInput.files[0]);

            try {
                const response = await fetch('/api/upload-excel', {
                    method: 'POST',
                    headers: getAuthHeaders(false),
                    body: formData
                });

                const data = await response.json();

                if (data.success) {
                    alert('File uploaded successfully!');
                } else {
                    alert('Error uploading file: ' + data.message);
                }
            } catch (error) {
                console.error('Error uploading file:', error);
                alert('Error uploading file');
            }
        });
    }

    // Save template handler
    if (messageTemplateForm) {
        messageTemplateForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            try {
                const response = await fetch('/api/config', {
                    method: 'PUT',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({
                        messageTemplate: messageTemplateEl.value
                    })
                });

                const data = await response.json();
                if (!response.ok) {
                    throw new Error(data.message || 'Failed to save template');
                }
                
                alert('Template saved successfully!');
            } catch (error) {
                console.error('Error saving template:', error);
                alert(`Error saving template: ${error.message}`);
            }
        });
    }

    // Send reminders handler
    if (sendRemindersBtn) {
        sendRemindersBtn.addEventListener('click', async () => {
            if (!confirm('Are you sure you want to send reminders to all students?')) return;
            
            try {
                const response = await fetch('/api/send-reminders', {
                    method: 'POST',
                    headers: getAuthHeaders()
                });

                const data = await response.json();
                if (data.success) {
                    alert(`Successfully sent ${data.sentCount} reminders!`);
                } else {
                    alert('Error sending reminders: ' + data.message);
                }
            } catch (error) {
                console.error('Error sending reminders:', error);
                alert('Error sending reminders');
            }
        });
    }

    if (logoutBtn) {
        logoutBtn.addEventListener('click', logout);
    }
});

// Check authentication on page load
function checkAuth() {
    const token = localStorage.getItem('authToken');
    if (!token) {
        window.location.href = '/login.html';
        return;
    }
    
    // Add token validation
    try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        if (!payload.userId || typeof payload.userId !== 'string') {
            logout();
        }
    } catch (e) {
        logout();
    }
}

// Logout function
function logout() {
    localStorage.removeItem('authToken');
    window.location.href = '/login.html';
}

// Update WhatsApp connection status
function updateWhatsAppConnectionStatus(message, type) {
    if (!whatsappStatusEl) return;

    whatsappStatusEl.className = `alert alert-${type} mb-3`;
    whatsappStatusEl.textContent = message;

    if (type === 'success' && message === 'Connected') {
        connectWhatsAppBtn?.classList.add('d-none');
        disconnectWhatsAppBtn?.classList.remove('d-none');
    } else {
        connectWhatsAppBtn?.classList.remove('d-none');
        disconnectWhatsAppBtn?.classList.add('d-none');
    }
}
