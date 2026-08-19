require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('./db/database');

const app = express();
const PORT = process.env.PORT || 3000;
const FREE_APPLICATION_LIMIT = 1;      // freelancer's first application is free
const APPLICATION_FEE_MWK = 500;       // placeholder fee — adjust as decided
const COMMISSION_RATE = 0.20;          // 20% platform commission

// Safe one-time database migrations for onboarding fields
const migrations = [
    "ALTER TABLE freelancer_profiles ADD COLUMN cv_path TEXT",
    "ALTER TABLE freelancer_profiles ADD COLUMN certificates_path TEXT",
    "ALTER TABLE freelancer_profiles ADD COLUMN availability TEXT",
    "ALTER TABLE freelancer_profiles ADD COLUMN onboarding_complete INTEGER DEFAULT 0"
];
migrations.forEach(sql => { try { db.exec(sql); } catch (e) { /* already exists */ } });

// File upload setup
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, `${req.session.user.id}-${file.fieldname}-${unique}${path.extname(file.originalname)}`);
    }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

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
    let currentUser = req.session.user || null;
    if (currentUser && currentUser.role === 'freelancer') {
        const status = db.prepare('SELECT is_verified FROM users WHERE id = ?').get(currentUser.id);
        currentUser = { ...currentUser, is_verified: status ? status.is_verified : 0 };
    }
    res.locals.currentUser = currentUser;
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

function requireOnboarding(req, res, next) {
    if (!req.session.user || req.session.user.role !== 'freelancer') return next();
    const profile = db.prepare('SELECT onboarding_complete FROM freelancer_profiles WHERE user_id = ?').get(req.session.user.id);
    if (!profile || !profile.onboarding_complete) {
        return res.redirect('/freelancer/onboarding/id');
    }
    const status = db.prepare('SELECT is_verified FROM users WHERE id = ?').get(req.session.user.id);
    if (!status || !status.is_verified) {
        return res.redirect('/freelancer/onboarding/pending');
    }
    next();
}

// ---------- Public pages ----------

app.get('/', (req, res) => {
    if (req.session.user) {
        return res.redirect('/dashboard');
    }
    const categories = db.prepare('SELECT * FROM categories ORDER BY name').all();
    res.render('index', { categories });
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
        res.redirect(role === 'freelancer' ? '/freelancer/onboarding/id' : '/');
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

app.get('/jobs', requireOnboarding, (req, res) => {
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

// Client browses/searches verified freelancers
app.get('/freelancers', requireLogin, requireRole('client'), (req, res) => {
    const { skill, city } = req.query;
    let query = `
        SELECT users.id, users.full_name, users.city, freelancer_profiles.bio,
               freelancer_profiles.skills, freelancer_profiles.hourly_rate,
               freelancer_profiles.availability, freelancer_profiles.rating_avg
        FROM users
        JOIN freelancer_profiles ON freelancer_profiles.user_id = users.id
        WHERE users.role = 'freelancer' AND users.is_verified = 1
    `;
    const params = [];
    if (skill) { query += ' AND freelancer_profiles.skills LIKE ?'; params.push(`%${skill}%`); }
    if (city) { query += ' AND users.city LIKE ?'; params.push(`%${city}%`); }
    query += ' ORDER BY freelancer_profiles.rating_avg DESC';

    const freelancers = db.prepare(query).all(...params);
    res.render('freelancers-browse', { freelancers, filters: { skill, city } });
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

// Freelancer applies to a job — enforces "first application free, then fee" and ID verification
app.post('/jobs/:id/apply', requireLogin, requireRole('freelancer'), (req, res) => {
    const { proposal, proposed_price } = req.body;
    const freelancerId = req.session.user.id;

    const applicant = db.prepare('SELECT is_verified FROM users WHERE id = ?').get(freelancerId);
    if (!applicant.is_verified) {
        return res.status(403).send('Your ID is still being reviewed. You can apply once verified.');
    }

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

// Client accepts an application -> creates a "held" escrow payment record, rejects the rest
app.post('/applications/:id/accept', requireLogin, requireRole('client'), (req, res) => {
    const application = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(application.job_id);

    const amount = application.proposed_price;
    const commission = amount * COMMISSION_RATE;
    const payout = amount - commission;

    db.prepare(`UPDATE applications SET status = 'accepted' WHERE id = ?`).run(application.id);
    db.prepare(`UPDATE applications SET status = 'rejected' WHERE job_id = ? AND id != ?`).run(job.id, application.id);
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

// ---------- Freelancer onboarding wizard ----------

const ONBOARDING_STEPS = ['id', 'certificates', 'cv', 'portfolio', 'skills', 'availability', 'rate'];

app.get('/freelancer/onboarding/:step', requireLogin, requireRole('freelancer'), (req, res) => {
    const { step } = req.params;
    if (step === 'pending') return res.render('onboarding-pending');
    if (!ONBOARDING_STEPS.includes(step)) return res.status(404).send('Not found.');
    res.render(`onboarding-${step}`, { stepIndex: ONBOARDING_STEPS.indexOf(step), totalSteps: ONBOARDING_STEPS.length });
});

app.post('/freelancer/onboarding/id', requireLogin, requireRole('freelancer'), upload.single('id_document'), (req, res) => {
    if (!req.file) return res.redirect('/freelancer/onboarding/id');
    db.prepare('UPDATE users SET id_document_path = ? WHERE id = ?').run(`/uploads/${req.file.filename}`, req.session.user.id);
    res.redirect('/freelancer/onboarding/certificates');
});

app.post('/freelancer/onboarding/certificates', requireLogin, requireRole('freelancer'), upload.single('certificates'), (req, res) => {
    if (req.file) {
        db.prepare('UPDATE freelancer_profiles SET certificates_path = ? WHERE user_id = ?').run(`/uploads/${req.file.filename}`, req.session.user.id);
    }
    res.redirect('/freelancer/onboarding/cv');
});

app.post('/freelancer/onboarding/cv', requireLogin, requireRole('freelancer'), upload.single('cv'), (req, res) => {
    if (!req.file) return res.redirect('/freelancer/onboarding/cv');
    db.prepare('UPDATE freelancer_profiles SET cv_path = ? WHERE user_id = ?').run(`/uploads/${req.file.filename}`, req.session.user.id);
    res.redirect('/freelancer/onboarding/portfolio');
});

app.post('/freelancer/onboarding/portfolio', requireLogin, requireRole('freelancer'), upload.array('portfolio', 5), (req, res) => {
    if (req.files && req.files.length) {
        const paths = req.files.map(f => `/uploads/${f.filename}`).join(',');
        db.prepare('UPDATE freelancer_profiles SET portfolio_images = ? WHERE user_id = ?').run(paths, req.session.user.id);
    }
    res.redirect('/freelancer/onboarding/skills');
});

app.post('/freelancer/onboarding/skills', requireLogin, requireRole('freelancer'), (req, res) => {
    db.prepare('UPDATE freelancer_profiles SET skills = ? WHERE user_id = ?').run(req.body.skills, req.session.user.id);
    res.redirect('/freelancer/onboarding/availability');
});

app.post('/freelancer/onboarding/availability', requireLogin, requireRole('freelancer'), (req, res) => {
    db.prepare('UPDATE freelancer_profiles SET availability = ? WHERE user_id = ?').run(req.body.availability, req.session.user.id);
    res.redirect('/freelancer/onboarding/rate');
});

app.post('/freelancer/onboarding/rate', requireLogin, requireRole('freelancer'), (req, res) => {
    db.prepare('UPDATE freelancer_profiles SET hourly_rate = ?, onboarding_complete = 1 WHERE user_id = ?').run(req.body.hourly_rate, req.session.user.id);
    res.redirect('/freelancer/onboarding/pending');
});

// ---------- Admin ----------

app.get('/admin/verifications', requireLogin, requireRole('admin'), (req, res) => {
    const pending = db.prepare(`
        SELECT users.*, freelancer_profiles.onboarding_complete
        FROM users JOIN freelancer_profiles ON freelancer_profiles.user_id = users.id
        WHERE users.role = 'freelancer' AND users.is_verified = 0 AND freelancer_profiles.onboarding_complete = 1
    `).all();
    res.render('admin-verifications', { pending });
});

app.post('/admin/verifications/:id/approve', requireLogin, requireRole('admin'), (req, res) => {
    db.prepare('UPDATE users SET is_verified = 1 WHERE id = ?').run(req.params.id);
    res.redirect('/admin/verifications');
});

// ---------- One-time admin setup (remove after use) ----------

app.get('/debug-key', (req, res) => {
    res.send('Server sees: [' + (process.env.ADMIN_SETUP_KEY || 'MISSING') + ']');
});

app.get('/setup-admin', (req, res) => {
    if (!process.env.ADMIN_SETUP_KEY || req.query.key !== process.env.ADMIN_SETUP_KEY) {
        return res.status(403).send('Forbidden.');
    }
    const info = db.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run(req.query.email);
    res.send(info.changes ? `${req.query.email} is now an admin.` : 'No user found with that email.');
});

// ---------- Dashboard ----------

app.get('/dashboard', requireLogin, requireOnboarding, (req, res) => {
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
