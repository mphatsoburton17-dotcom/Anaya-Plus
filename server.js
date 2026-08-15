require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('./db/database');

const app = express();
const PORT = process.env.PORT || 3000;
const FREE_APPLICATION_LIMIT = 1;      // freelancer's first application is free
const APPLICATION_FEE_MWK = 500;       // placeholder fee — adjust as decided
const COMMISSION_RATE = 0.20;          // 20% platform commission

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } // 1 week
}));

// Make current user + brand info available in every template
app.use((req, res, next) => {
    res.locals.currentUser = req.session.user || null;
    res.locals.brand = { name: 'AnayaPlus', tagline: 'Local Services Marketplace' };
    next();
});

function requireLogin(req, res, next) {
    if (!req.session.user) return res.redirect('/login');
    next();
}

function requireRole(role) {
    return (req, res, next) => {
        if (!req.session.user || req.session.user.role !== role) {
            return res.status(403).send('Not authorized for this page.');
        }
        next();
    };
}

// ---------- Public pages ----------

app.get('/', (req, res) => {
    const categories = db.prepare('SELECT * FROM categories ORDER BY name').all();
    const recentJobs = db.prepare(`
        SELECT jobs.*, categories.name AS category_name
        FROM jobs JOIN categories ON jobs.category_id = categories.id
        WHERE jobs.status = 'open'
        ORDER BY jobs.created_at DESC LIMIT 6
    `).all();
    res.render('index', { categories, recentJobs });
});

app.get('/signup', (req, res) => res.render('signup', { error: null }));

app.post('/signup', (req, res) => {
    const { full_name, email, phone, password, role, city } = req.body;
    try {
        const password_hash = bcrypt.hashSync(password, 10);
        const info = db.prepare(`
            INSERT INTO users (full_name, email, phone, password_hash, role, city)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(full_name, email, phone, password_hash, role, city);

        if (role === 'freelancer') {
            db.prepare('INSERT INTO freelancer_profiles (user_id) VALUES (?)').run(info.lastInsertRowid);
        }

        req.session.user = { id: info.lastInsertRowid, full_name, role };
        res.redirect(role === 'freelancer' ? '/freelancer/profile/edit' : '/');
    } catch (err) {
        res.render('signup', { error: 'That email or phone is already registered.' });
    }
});

app.get('/login', (req, res) => res.render('login', { error: null }));

app.post('/login', (req, res) => {
    const { email, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        return res.render('login', { error: 'Invalid email or password.' });
    }
    req.session.user = { id: user.id, full_name: user.full_name, role: user.role };
    res.redirect('/');
});

app.post('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

// ---------- Jobs ----------

app.get('/jobs', (req, res) => {
    const { category, city } = req.query;
    let query = `
        SELECT jobs.*, categories.name AS category_name
        FROM jobs JOIN categories ON jobs.category_id = categories.id
        WHERE jobs.status = 'open'
    `;
    const params = [];
    if (category) { query += ' AND categories.id = ?'; params.push(category); }
    if (city) { query += ' AND jobs.city LIKE ?'; params.push(`%${city}%`); }
    query += ' ORDER BY jobs.created_at DESC';

    const jobs = db.prepare(query).all(...params);
    const categories = db.prepare('SELECT * FROM categories ORDER BY name').all();
    res.render('jobs-browse', { jobs, categories, filters: { category, city } });
});

app.get('/jobs/new', requireLogin, requireRole('client'), (req, res) => {
    const categories = db.prepare('SELECT * FROM categories ORDER BY name').all();
    res.render('job-new', { categories });
});

app.post('/jobs/new', requireLogin, requireRole('client'), (req, res) => {
    const { title, description, budget_mwk, category_id, city, deadline } = req.body;
    const info = db.prepare(`
        INSERT INTO jobs (client_id, category_id, title, description, budget_mwk, city, deadline)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(req.session.user.id, category_id, title, description, budget_mwk, city, deadline);
    res.redirect(`/jobs/${info.lastInsertRowid}`);
});

app.get('/jobs/:id', (req, res) => {
    const job = db.prepare(`
        SELECT jobs.*, categories.name AS category_name, users.full_name AS client_name
        FROM jobs
        JOIN categories ON jobs.category_id = categories.id
        JOIN users ON jobs.client_id = users.id
        WHERE jobs.id = ?
    `).get(req.params.id);
    if (!job) return res.status(404).send('Job not found.');

    const applications = db.prepare(`
        SELECT applications.*, users.full_name, freelancer_profiles.rating_avg
        FROM applications
        JOIN users ON applications.freelancer_id = users.id
        LEFT JOIN freelancer_profiles ON freelancer_profiles.user_id = users.id
        WHERE applications.job_id = ?
        ORDER BY applications.created_at DESC
    `).all(req.params.id);

    res.render('job-detail', { job, applications });
});

// Freelancer applies to a job — enforces "first application free, then fee"
app.post('/jobs/:id/apply', requireLogin, requireRole('freelancer'), (req, res) => {
    const { proposal, proposed_price } = req.body;
    const freelancerId = req.session.user.id;

    const profile = db.prepare('SELECT * FROM freelancer_profiles WHERE user_id = ?').get(freelancerId);
    const isFree = profile.has_used_free_application < FREE_APPLICATION_LIMIT;
    const feePaid = isFree ? 0 : APPLICATION_FEE_MWK;

    // NOTE: in production, if isFree is false, charge the fee via PayChangu
    // BEFORE inserting the application, and only proceed on successful payment.

    try {
        db.prepare(`
            INSERT INTO applications (job_id, freelancer_id, proposal, proposed_price, was_free_application, application_fee_paid)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(req.params.id, freelancerId, proposal, proposed_price, isFree ? 1 : 0, feePaid);

        if (isFree) {
            db.prepare('UPDATE freelancer_profiles SET has_used_free_application = has_used_free_application + 1 WHERE user_id = ?')
                .run(freelancerId);
        }

        res.redirect(`/jobs/${req.params.id}`);
    } catch (err) {
        res.status(400).send('You may have already applied to this job.');
    }
});

// Client accepts an application -> creates a "held" escrow payment record
app.post('/applications/:id/accept', requireLogin, requireRole('client'), (req, res) => {
    const application = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(application.job_id);

    const amount = application.proposed_price;
    const commission = amount * COMMISSION_RATE;
    const payout = amount - commission;

    db.prepare(`UPDATE applications SET status = 'accepted' WHERE id = ?`).run(application.id);
    db.prepare(`UPDATE jobs SET status = 'in_progress' WHERE id = ?`).run(job.id);
    db.prepare(`
        INSERT INTO payments (job_id, client_id, freelancer_id, amount_mwk, commission_mwk, payout_mwk, status)
        VALUES (?, ?, ?, ?, ?, ?, 'held')
    `).run(job.id, job.client_id, application.freelancer_id, amount, commission, payout);

    // NOTE: in production, this is where you'd trigger the actual PayChangu
    // charge to the client before marking the payment as held.

    res.redirect(`/jobs/${job.id}`);
});

// ---------- Freelancer profile ----------

app.get('/freelancer/profile/edit', requireLogin, requireRole('freelancer'), (req, res) => {
    const profile = db.prepare('SELECT * FROM freelancer_profiles WHERE user_id = ?').get(req.session.user.id);
    res.render('freelancer-profile-edit', { profile });
});

app.post('/freelancer/profile/edit', requireLogin, requireRole('freelancer'), (req, res) => {
    const { bio, skills, hourly_rate } = req.body;
    db.prepare(`
        UPDATE freelancer_profiles SET bio = ?, skills = ?, hourly_rate = ? WHERE user_id = ?
    `).run(bio, skills, hourly_rate, req.session.user.id);
    res.redirect('/dashboard');
});

// ---------- Dashboard ----------

app.get('/dashboard', requireLogin, (req, res) => {
    const user = req.session.user;
    if (user.role === 'client') {
        const jobs = db.prepare('SELECT * FROM jobs WHERE client_id = ? ORDER BY created_at DESC').all(user.id);
        return res.render('dashboard-client', { jobs });
    } else {
        const applications = db.prepare(`
            SELECT applications.*, jobs.title, jobs.status AS job_status
            FROM applications JOIN jobs ON applications.job_id = jobs.id
            WHERE applications.freelancer_id = ?
            ORDER BY applications.created_at DESC
        `).all(user.id);
        return res.render('dashboard-freelancer', { applications });
    }
});

app.listen(PORT, () => {
    console.log(`AnayaPlus running at http://localhost:${PORT}`);
});
