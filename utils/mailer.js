const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

async function sendMail(to, subject, html) {
    try {
        await transporter.sendMail({
            from: `"AnayaPlus" <${process.env.EMAIL_USER}>`,
            to,
            subject,
            html
        });
        console.log('Email sent to', to);
    } catch (err) {
        console.error('Email send failed:', err.message);
    }
}

module.exports = { sendMail };
