function getAuthHeaders(includeJson = true) {
    const token = localStorage.getItem('authToken');
    if (!token) {
        console.error('No auth token found');
        logout();
        return {};
    }
    
    return {
        Authorization: `Bearer ${token}`,
        ...(includeJson && { 'Content-Type': 'application/json' })
    };
}

// Check authentication
function checkAuth() {
    const token = localStorage.getItem('authToken');
    if (!token) {
        window.location.href = '/login.html';
        return;
    }
}

// Logout function
function logout() {
    localStorage.removeItem('authToken');
    window.location.href = '/login.html';
}

// Load students
async function fetchStudents() {
    try {
        const response = await fetch('/api/students', {
            method: "GET",
            headers: getAuthHeaders() // Direct headers assignment
        });

        if (!response.ok) {
            if (response.status === 401) {
                logout();
                return;
            }
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        if (data.success) {
            renderStudents(data.students);
        } else {
            console.error('API Error:', data.message);
        }
    } catch (error) {
        console.error('Fetch Error:', error);
        if (error.message.includes('401')) {
            logout();
        }
    }
}


// Display students in table
// Corrected render function with proper property names
function renderStudents(students) {
    const tbody = document.getElementById('studentsTableBody');
    if (!tbody) return;

    tbody.innerHTML = '';
    students.forEach(student => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${student.name}</td>
            <td>${student.phone}</td>
            <td>${student.amount}</td>
            <td>${new Date(student.dueDate).toLocaleString('en-US', {
                timeZone: 'Asia/Kolkata'
            })}</td>
            <td>${student.last_reminder_sent ? 
                new Date(student.last_reminder_sent).toLocaleString() : 
                'Never'}</td>
            <td>
                <span class="badge bg-${student.last_reminder_sent ? 'success' : 'warning'}">
                    ${student.last_reminder_sent ? 'Sent' : 'Pending'}
                </span>
            </td>
        `;
        tbody.appendChild(row);
    });
}

// Format date time
function formatDateTime(dateTime) {
    if (!dateTime) return 'Not scheduled';
    return new Date(dateTime).toLocaleString();
}

// Get status color
function getStatusColor(status) {
    switch(status) {
        case 'sent': return 'success';
        case 'failed': return 'danger';
        case 'scheduled': return 'warning';
        default: return 'secondary';
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', function () {
    checkAuth();
    fetchStudents(); // Call the corrected unified function

    // Optional: Refresh button handler
    document.getElementById('refreshBtn')?.addEventListener('click', fetchStudents);

    // Add send functionality
    document.getElementById('sendReminders')?.addEventListener('click', async () => {
        if (!confirm('Are you sure you want to send reminders to all students?')) return;

        try {
            const response = await fetch('/api/send-reminders', {
                method: 'POST',
                headers: getAuthHeaders()
            });

            const data = await response.json();
            
            if (!response.ok) {
                throw new Error(data.message || 'Failed to send messages');
            }

            if (data.errors.length > 0) {
                alert(`Sent ${data.sentCount} messages. Errors:\n${
                    data.errors.map(e => `${e.student}: ${e.error}`).join('\n')
                }`);
            } else {
                alert(`Successfully sent ${data.sentCount} messages!`);
            }
            
            // Refresh the list
            fetchStudents();

        } catch (error) {
            console.error('Send Error:', error);
            alert(`Error: ${error.message}`);
        }
    });

    // Add disconnect WhatsApp functionality
    document.getElementById('disconnectWhatsApp')?.addEventListener('click', async () => {
        if (confirm('Are you sure you want to disconnect WhatsApp?')) {
            try {
                const response = await fetch('/api/disconnect-whatsapp', {
                    method: 'POST',
                    headers: getAuthHeaders()
                });

                const data = await response.json();
                if (data.success) {
                    alert('WhatsApp disconnected successfully.');
                    // Optionally, you can redirect or update the UI
                } else {
                    alert('Error disconnecting WhatsApp: ' + data.message);
                }
            } catch (error) {
                console.error('Error disconnecting WhatsApp:', error);
                alert('Error disconnecting WhatsApp');
            }
        }
    });

    // Add date picker handler
    document.querySelectorAll('.schedule-picker').forEach(picker => {
        picker.addEventListener('change', async (e) => {
            const response = await fetch('/api/schedule-reminder', {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify({
                    studentId: e.target.dataset.studentId,
                    date: e.target.value
                })
            });
            
            if (response.ok) {
                alert('Reminder scheduled successfully!');
            } else {
                alert('Failed to schedule reminder.');
            }
        });
    });
});
