# AnayaPlus — MVP Starter

A local services marketplace (branch of Anaya Store) connecting Malawian clients with local freelancers.

## What's included
- **Database:** SQLite schema (`db/schema.sql`) covering users, freelancer profiles, jobs, applications, messages, escrow payments, reviews, and disputes
- **Backend:** Node.js + Express server (`server.js`) with signup/login, job posting, job browsing, applications (with the "first application free, then paid" rule built in), and a basic escrow flow (accept application → hold payment)
- **Frontend:** Server-rendered EJS pages styled in the AnayaPlus orange/yellow brand

## How to run it

1. Install [Node.js](https://nodejs.org) (v18 or later) if you don't have it.
2. Open a terminal in this folder and run:
   ```
   npm install
   npm start
   ```
3. Open your browser to `http://localhost:3000`

The SQLite database file will be created automatically at `db/anayaplus.db` the first time you run it, with categories pre-seeded.

## What's stubbed / not yet real

This is a working MVP skeleton, not production-ready. Before launch:

- **PayChangu integration:** the accept-application route currently just marks a payment as "held" in the database — it does NOT actually charge the client yet. You need to call PayChangu's checkout/charge API there, and only mark it "held" once that payment succeeds. Same for the application fee (freelancer applying beyond their free one) — currently the fee is calculated but not actually charged.
- **Payout release:** there's no route yet for a client marking a job "delivered/approved" and triggering the actual payout to the freelancer minus commission. That's the next piece to build once PayChangu confirms their split-payment/payout capability.
- **ID document upload:** the `id_document_path` field exists in the schema but there's no upload form yet — needs file upload handling (e.g. multer) plus secure storage.
- **Messaging:** the `messages` table exists but there's no chat UI yet.
- **Reviews:** the `reviews` table exists but there's no review-submission UI yet.
- **Disputes:** the `disputes` table exists but there's no UI to raise/view disputes yet.
- **Security for production:** change `SESSION_SECRET` in a `.env` file, add input validation/sanitization, add rate limiting, and move off SQLite to Postgres/MySQL once you have real concurrent traffic.

## Suggested next build order
1. Get this running locally and click through signup → post job → apply → accept
2. Wire up real PayChangu charges for the escrow deposit and application fees
3. Add the "mark delivered" + "approve & release payout" flow
4. Add ID document upload
5. Add messaging
6. Add reviews + ratings display
7. Add dispute submission form
