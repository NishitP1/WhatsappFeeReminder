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
const { v4: uuidv4 } = require('uuid'); 


require('dotenv').config(); 
const JWT_SECRET = process.env.JWT_SECRET; 


fs.ensureDirSync('logs');
fs.ensureDirSync('uploads');


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


const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload({
    createParentPath: true,
    // limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
}));
app.use(express.static('public'));

// Middleware
app.use(cors({
    origin: 'http://localhost:3000',
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization']
}));


const clients = new Map(); 


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
            socket.user = user; 
            next();
        });
    } catch (error) {
        next(error);
    }
});

const userSockets = new Map(); 


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
            fs.ensureDirSync(authDir); 

            const client = new Client({
                authStrategy: new LocalAuth({ dataPath: authDir }),
                puppeteer: {
                    headless: true,
                    args: ['--no-sandbox', '--disable-setuid-sandbox']
                }
            });

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

            await client.initialize(); 

        } catch (error) {
            logger.error(`Initialization error: ${error.message}`);
            socket.emit('whatsappStatus', { 
                ready: false, 
                error: 'Connection failed' 
            });
        }
    });

    
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

        
        await excelFile.mv(uploadPath);

       
        const workbook = XLSX.readFile(uploadPath);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];

        
        const students = XLSX.utils.sheet_to_json(worksheet).map(student => {
           
            const rawPhone = student.Phone.toString().replace(/\D/g, '');
            const fullPhone = `+${rawPhone}`;
            
            return {
                ...student,
                Phone: fullPhone,
                DueDate: student.DueDate ? 
                    XLSX.SSF.format('yyyy-mm-dd', new Date(student.DueDate)) : 
                    null
            };
        });


        for (const student of students) {
           
            if (!student.Name || !student.Phone || !student.Amount) {
                throw new Error(`Missing required fields for student: ${student.Name}`);
            }

            if (!/^\+\d{8,20}$/.test(student.Phone)) {
                throw new Error(`Invalid phone format for ${student.Name}: ${student.Phone}`);
            }
            
            if (isNaN(student.Amount)) {
                throw new Error(`Invalid amount for ${student.Name}: ${student.Amount}`);
            }
        }

        await pool.query('DELETE FROM students'); 
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
            message: 'Error uploading file: ' + error.message 
        });
    }
});

app.put('/api/config', authenticateToken, async (req, res) => {
    try {
        const { messageTemplate } = req.body;

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
    logger.debug('Received Auth Header:', authHeader);

    const token = authHeader?.split(' ')[1];
    if (!token) {
        logger.warn('No token provided'); 
        return res.status(401).json({ success: false, message: 'No token provided' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            logger.error(`Invalid token: ${err.message}`); 
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

        
        if (!username || !password) {
            return res.status(400).json({ success: false, message: 'Username and password are required.' });
        }

        // Check if user exists
        const [existingUsers] = await pool.query('SELECT id FROM users WHERE username = ?', [username]);
        if (existingUsers.length > 0) {
            return res.status(400).json({ success: false, message: 'Username already exists.' });
        }

        
        const hashedPassword = await bcrypt.hash(password, 10);

      
        await pool.query(
            'INSERT INTO users (id, username, password) VALUES (?, ?, ?)',
            [uuidv4(), username, hashedPassword] 
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

        const [users] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
        if (users.length === 0) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        const user = users[0];
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

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

app.use('/api/*', authenticateToken);

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

        const [students] = await pool.query(`
            SELECT name, phone, amount, due_date 
            FROM students
        `);
        const config = fs.readJsonSync(configPath);

        let sentCount = 0;
        const errors = [];

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
    const { userId, message, phoneNumber } = req.body;

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

cron.schedule('0 0 * * *', async () => {
    const [dueReminders] = await pool.query(`
        SELECT * FROM students 
        WHERE DATE_ADD(due_date, INTERVAL 2 DAY) = CURDATE() 
        AND is_sent = false
    `);

    for (const reminder of dueReminders) {
        await sendWhatsAppMessage(reminder, null); 
        await pool.query(`
            UPDATE students 
            SET is_sent = true 
            WHERE id = ?
        `, [reminder.id]);
    }
});


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

const PORT = process.env.PORT;
server.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
});