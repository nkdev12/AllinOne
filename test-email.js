require('dotenv').config();
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: false, // port 587 uses STARTTLS
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD
  }
});

transporter.verify(function (error, success) {
  if (error) {
    console.log("SMTP Verification Error:", error);
  } else {
    console.log("Server is ready to take our messages");
    
    // Optionally send a test email
    transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: process.env.SMTP_FROM,
      subject: "Test Email from AllinOne Backend",
      text: "If you get this, SMTP is working!"
    }, (err, info) => {
      if (err) {
        console.error("Failed to send test email:", err);
      } else {
        console.log("Test email sent:", info.response);
      }
    });
  }
});
