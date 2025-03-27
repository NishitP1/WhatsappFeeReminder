const express = require('express');
const fileUpload = require('express-fileupload');
const http = require('http');
const socketIo = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const XLSX = require('xlsx');
const cron = require('node-cron');
const fs = require('fs-extra');
const path = require('path');
const winston = require('winston');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const pool = require('./config/database');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid'); // Import UUID generator
const moment = require('moment');

// Environment variables
require('dotenv').config(); 
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key'; 

// Create necessary directories
fs.ensureDirSync('logs');
fs.ensureDirSync('uploads');

// Setup logging
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`)
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'logs/fee-reminder.log', maxsize: 5242880, maxFiles: 5 })
    ]
});

// Load configuration
const configPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
    const defaultConfig = {
        excelFilePath: 'uploads/student_fees.xlsx',
        defaultCountryCode: '+91',
        messageTemplate: "Dear {{name}},\n\nThis is a reminder that your fee payment of {{amount}} is pending.\n\nPlease make the payment as soon as possible to avoid any late fees.\n\nRegards,\nSchool Administration"
    };
    fs.writeJsonSync(configPath, defaultConfig, { spaces: 2 });
    logger.info('Created default configuration file');
}
let config = fs.readJsonSync(configPath);

// Express app setup
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload({
    createParentPath: true,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
}));
app.use(express.static('public'));

// Middleware
app.use(cors({
    origin: 'http://localhost:3000',
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Keep only the clients Map
const clients = new Map(); // Store clients by user ID

// Add this before your io.on('connection') handler
io.use((socket, next) => {
    try {
        const token = socket.handshake.auth.token;
        if (!token) {
            logger.warn('No token provided for WebSocket connection');
            return next(new Error('Authentication error'));
        }
        
        jwt.verify(token, JWT_SECRET, (err, user) => {
            if (err) {
                logger.error('WebSocket auth error:', err.message);
                return next(new Error('Authentication error'));
            }
            socket.user = user; // Attach user info to socket
            next();
        });
    } catch (error) {
        next(error);
    }
});

// Add at the top with other declarations
const userSockets = new Map(); // Store user socket references

// Handle WebSocket connections
io.on('connection', (socket) => {
    logger.info('Client connected via WebSocket');
    
    if (socket.user?.userId) {
        userSockets.set(socket.user.userId, socket);
    }

    socket.on('disconnect', () => {
        if (socket.user?.userId) {
            userSockets.delete(socket.user.userId);
        }
    });

    socket.on('initializeWhatsApp', async () => {
        if (!socket.user) {
            logger.error('Unauthorized WhatsApp initialization attempt');
            return socket.disconnect(true);
        }

        try {
            const userId = socket.user.userId.toString();
            const phoneNumber = String(socket.user.phone || socket.user.username);
            
            if (clients.has(userId)) {
                return socket.emit('whatsappStatus', { 
                    ready: true, 
                    message: 'Already connected' 
                });
            }

            const authDir = path.join(__dirname, 'whatsapp-auth', userId);
            fs.ensureDirSync(authDir); // Ensure the directory exists

            const client = new Client({
                authStrategy: new LocalAuth({ dataPath: authDir }),
                puppeteer: {
                    headless: true,
                    args: ['--no-sandbox', '--disable-setuid-sandbox']
                }
            });

            // Event listeners directly on the client
            client.on('qr', async (qr) => {
                const qrCodeDataURL = await qrcode.toDataURL(qr);
                socket.emit('qrCode', { qrCodeDataURL });
            });

            client.on('ready', () => {
                clients.set(userId, client);
                socket.emit('whatsappStatus', { ready: true });
            });

            client.on('disconnected', () => {
                clients.delete(userId);
                socket.emit('whatsappStatus', { ready: false });
            });

            await client.initialize(); // Initialize the client

        } catch (error) {
            logger.error(`Initialization error: ${error.message}`);
            socket.emit('whatsappStatus', { 
                ready: false, 
                error: 'Connection failed' 
            });
        }
    });

    // Add other socket handlers here
    socket.on('disconnectWhatsApp', async () => {
        const userId = socket.user?.userId?.toString();
        if (userId && clients.has(userId)) {
            await clients.get(userId).destroy();
            clients.delete(userId);
        }
    });
});

app.post('/api/upload-excel', authenticateToken, async (req, res) => {
    try {
        if (!req.files || !req.files.excelFile) {
            return res.status(400).json({ 
                success: false, 
                message: 'No Excel file uploaded' 
            });
        }

        const excelFile = req.files.excelFile;
        const uploadPath = path.join(__dirname, 'uploads', 'student_fees.xlsx');

        // Save the file
        await excelFile.mv(uploadPath);

        // Read the Excel file
        const workbook = XLSX.readFile(uploadPath);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];

        // Process students from the Excel file
        const students = XLSX.utils.sheet_to_json(worksheet).map(student => {
            // Convert to international format
            const rawPhone = student.Phone.toString().replace(/\D/g, '');
            const fullPhone = `+${rawPhone}`;
            
            return {
                ...student,
                Phone: fullPhone, // Store combined number
                DueDate: student.DueDate ? 
                    XLSX.SSF.format('yyyy-mm-dd', new Date(student.DueDate)) : 
                    null // Format date
            };
        });

        // Validate data format
        for (const student of students) {
            // Check for required fields
            if (!student.Name || !student.Phone || !student.Amount) {
                throw new Error(`Missing required fields for student: ${student.Name}`);
            }

            // Validate phone number format
            if (!/^\+\d{8,20}$/.test(student.Phone)) {
                throw new Error(`Invalid phone format for ${student.Name}: ${student.Phone}`);
            }
            
            // Validate amount
            if (isNaN(student.Amount)) {
                throw new Error(`Invalid amount for ${student.Name}: ${student.Amount}`);
            }
        }

        // Save students to the database
        await pool.query('DELETE FROM students'); // Clear existing data
        for (const student of students) {
            await pool.query(
                'INSERT INTO students (name, phone, amount, due_date) VALUES (?, ?, ?, ?)',
                [student.Name, student.Phone, student.Amount, student.DueDate]
            );
        }

        res.json({ 
            success: true, 
            message: 'File uploaded successfully', 
            students 
        });
    } catch (error) {
        console.error('Error uploading file:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error uploading file: ' + error.message // Include error message
        });
    }
});

// Add this endpoint before the authentication middleware
app.put('/api/config', authenticateToken, async (req, res) => {
    try {
        const { messageTemplate } = req.body;

        // Update config file
        const config = fs.readJsonSync(configPath);
        config.messageTemplate = messageTemplate;
        fs.writeJsonSync(configPath, config, { spaces: 2 });
        
        res.json({ success: true, message: 'Template updated successfully' });
    } catch (error) {
        logger.error('Error saving template:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error saving template' 
        });
    }
});

// Authentication middleware
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    logger.debug('Received Auth Header:', authHeader); // Added logging for auth header

    const token = authHeader?.split(' ')[1];
    if (!token) {
        logger.warn('No token provided'); // Added warning log
        return res.status(401).json({ success: false, message: 'No token provided' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            logger.error(`Invalid token: ${err.message}`); // Added error logging
            return res.status(403).json({ 
                success: false, 
                message: err.name === 'TokenExpiredError' 
                    ? 'Token expired' 
                    : 'Invalid token' 
            });
        }
        req.user = user;
        next();
    });
}

// Registration endpoint
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body; 
        // Validate fields
        if (!username || !password) {
            return res.status(400).json({ success: false, message: 'Username and password are required.' });
        }

        // Check if user exists
        const [existingUsers] = await pool.query('SELECT id FROM users WHERE username = ?', [username]);
        if (existingUsers.length > 0) {
            return res.status(400).json({ success: false, message: 'Username already exists.' });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create user without instituteName
        await pool.query(
            'INSERT INTO users (id, username, password) VALUES (?, ?, ?)',
            [uuidv4(), username, hashedPassword] // Generate UUID
        );

        res.json({ success: true, message: 'Registration successful.' });
    } catch (error) {
        logger.error(`Registration error: ${error.message}`);
        res.status(500).json({ success: false, message: 'Error during registration.' });
    }
});

// Login endpoint
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        // Fetch user from database
        const [users] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
        if (users.length === 0) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        const user = users[0];
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        // Generate token with expiration
        const token = jwt.sign(
            { userId: user.id, username: user.username },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({ success: true, token, message: 'Login successful' });
    } catch (error) {
        logger.error(`Login error: ${error.message}`);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// Protect all API routes with authentication
app.use('/api/*', authenticateToken);

// New route to fetch students
app.get('/api/students', authenticateToken, async (req, res) => {
    try {
        const [students] = await pool.query(`
            SELECT 
                name AS name,
                phone AS phone,
                amount AS amount,
                due_date AS dueDate 
            FROM students
        `);
        res.json({ success: true, students });
    } catch (error) {
        logger.error('Error fetching students:', error);
        res.status(500).json({ success: false, message: "Error loading students." });
    }
});

// Add this GET endpoint for loading the config
app.get('/api/config', authenticateToken, (req, res) => {
    try {
        const config = fs.readJsonSync(configPath);
        res.json({ success: true, ...config });
    } catch (error) {
        logger.error('Error loading config:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error loading configuration' 
        });
    }
});

// Modify the send-reminders endpoint
app.post('/api/send-reminders', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId.toString();
        const client = clients.get(userId);

        if (!client || !client.info) {
            return res.status(400).json({
                success: false,
                message: 'WhatsApp not connected'
            });
        }

        // Get students and config
        const [students] = await pool.query(`
            SELECT name, phone, amount, due_date 
            FROM students
        `);
        const config = fs.readJsonSync(configPath);

        let sentCount = 0;
        const errors = [];

        // Send messages
        for (const student of students) {
            try {
                const sanitizedPhone = student.phone.replace('+', '').replace(/\D/g, '');
                const phoneNumber = `${sanitizedPhone}@c.us`;

                const message = config.messageTemplate
                    .replace('{{name}}', student.name)
                    .replace('{{amount}}', student.amount)
                    .replace('{{dueDate}}', student.due_date);

                await client.sendMessage(phoneNumber, message);
                sentCount++;

                await pool.query(
                    'UPDATE students SET last_reminder_sent = NOW() WHERE phone = ?',
                    [student.phone]
                );

            } catch (error) {
                errors.push({
                    student: student.name,
                    error: error.message 
                });
                logger.error(`Failed to send to ${student.name}: ${error.message}`);
            }
        }

        res.json({
            success: true,
            sentCount,
            errors,
            message: `Sent ${sentCount} messages with ${errors.length} errors`
        });

    } catch (error) {
        logger.error('Send reminders error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send reminders'
        });
    }
});

app.post('/api/disconnect-whatsapp', authenticateToken, async (req, res) => {
    try {
        if (clients.size > 0) {
            for (const client of clients.values()) {
                await client.destroy();
            }
            clients.clear();
            io.emit('whatsappStatus', { ready: false });
            return res.json({ success: true, message: 'WhatsApp disconnected' });
        } else {
            return res.status(400).json({ success: false, message: 'WhatsApp is not connected' });
        }
    } catch (error) {
        logger.error('Error disconnecting WhatsApp:', error);
        res.status(500).json({ success: false, message: 'Error disconnecting WhatsApp' });
    }
});

app.post('/api/send-message', authenticateToken, async (req, res) => {
    const { userId, message, phoneNumber } = req.body; // Assume you send userId, message, and phoneNumber in the request

    const client = clients.get(userId);
    if (!client) {
        return res.status(400).json({ success: false, message: 'WhatsApp client not initialized' });
    }

    try {
        await client.sendMessage(`${phoneNumber}@c.us`, message);
        res.json({ success: true, message: 'Message sent successfully' });
    } catch (error) {
        logger.error(`Failed to send message to ${phoneNumber}:`, error);
        res.status(500).json({ success: false, message: 'Failed to send message' });
    }
});

// Add this cron job (runs every day at midnight)
cron.schedule('0 0 * * *', async () => {
    const twoDaysAgo = moment().subtract(2, 'days').format('YYYY-MM-DD');

    const [dueReminders] = await pool.query(`
        SELECT * FROM students 
        WHERE due_date = ? 
        AND is_sent = false
    `, [twoDaysAgo]);

    for (const reminder of dueReminders) {
        await sendWhatsAppMessage(reminder, null); // Send message without socket
        await pool.query(`
            UPDATE students 
            SET is_sent = true 
            WHERE id = ?
        `, [reminder.id]);
    }
});

// New API endpoint for scheduling
app.post('/api/schedule-reminder', authenticateToken, async (req, res) => {
    const { studentId, date } = req.body;
    
    await pool.query(`
        UPDATE students 
        SET reminder_date = ?, is_sent = false 
        WHERE id = ?
    `, [date, studentId]);

    res.json({ success: true });
});

async function sendWhatsAppMessage(reminder, socket) {
    try {
        const sanitizedPhone = reminder.phone.replace('+', '').replace(/\D/g, '');
        const phoneNumber = `${sanitizedPhone}@c.us`;
        
        await whatsappClient.sendMessage(phoneNumber, reminder.message);
        
        await pool.query(
            'UPDATE students SET last_reminder_sent = NOW() WHERE id = ?',
            [reminder.id]
        );
        
        if (socket) {
            socket.emit('messageStatus', {
                id: reminder.id,
                status: 'sent'
            });
        }
    } catch (error) {
        logger.error(`Failed to send to ${reminder.name}: ${error.message}`);
        if (socket) {
            socket.emit('messageStatus', {
                id: reminder.id,
                status: 'failed',
                error: error.message
            });
        }
    }
}

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
});