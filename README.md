# WhatsappFeeReminder
# WhatsApp Fee Reminder System
# WhatsApp Fee Reminder System

## Overview
The WhatsApp Fee Reminder System is a web application designed to automate fee reminders for students via WhatsApp. It allows educational institutions to send timely reminders to students about pending fee payments, improving fee collection efficiency.

## Features
- **User Authentication**: Secure login and registration using JWT.
- **Student Management**: Upload student data from Excel files.
- **WhatsApp Integration**: Send reminders directly through WhatsApp.
- **Automated Scheduling**: Schedule reminders to be sent automatically.
- **Real-Time Updates**: Receive real-time updates on WhatsApp connection status and message delivery.

## Technologies Used
- **Backend**: Node.js, Express
- **Database**: MySQL
- **Authentication**: JSON Web Tokens (JWT)
- **File Uploads**: express-fileupload
- **Real-Time Communication**: Socket.IO
- **WhatsApp API**: whatsapp-web.js
- **Task Scheduling**: node-cron
- **Logging**: Winston
- **Frontend**: HTML, CSS, JavaScript, Bootstrap

## Installation

### Prerequisites
- Node.js (v14 or higher)
- MySQL Server
- npm (Node Package Manager)

### Steps
1. **Clone the Repository**:
   ```bash
   git clone https://github.com/yourusername/whatsapp-fee-reminder.git
   cd whatsapp-fee-reminder
   ```

2. **Install Dependencies**:
   ```bash
   npm install
   ```

3. **Set Up Environment Variables**:
   Create a `.env` file in the root directory and add the following:
   ```plaintext
   DB_HOST=localhost
   DB_USER=root
   DB_PASSWORD=your_password
   DB_NAME=whatsapp_reminder
   JWT_SECRET=your_jwt_secret
   ```

4. **Create Database**:
   Create a MySQL database named `whatsapp_reminder` and set up the necessary tables (refer to the SQL scripts in the repository if available).

5. **Run the Application**:
   ```bash
   npm start
   ```

6. **Access the Application**:
   Open your browser and navigate to `http://localhost:3000`.

## Usage
- **Register**: Create a new account by navigating to the registration page.
- **Login**: Use your credentials to log in to the dashboard.
- **Upload Student Data**: Upload an Excel file containing student information.
- **Send Reminders**: Use the dashboard to send reminders to students.

## Cron Jobs
The application includes a cron job that runs daily to send reminders to students whose due date is 2 days past. Ensure that the cron job is set up correctly in the server code.

## Contributing
Contributions are welcome! Please fork the repository and submit a pull request for any enhancements or bug fixes.

## License
This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments
- [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) for WhatsApp integration.
- [Express](https://expressjs.com/) for the web framework.
- [Socket.IO](https://socket.io/) for real-time communication.

## Contact
For any inquiries, please contact [your_email@example.com].
