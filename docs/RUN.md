# How to run it, step by step

You need **Node 22.13 or newer** (check with `node --version`). There is nothing to install: the project has no npm dependencies.

## 1. Get the code

```
git clone https://github.com/ahmed192a/accounting-poc.git
cd accounting-poc
```

## 2. Start the app

```
npm start
```

Open <http://localhost:3000>. Data lives in memory and resets when you stop the server. To keep data in a file:

```
PORT=4000 DB_PATH=./data.db npm start
```

## 3. Try it as each role

Use the **Signed in as** menu at the top. The demo has six people:

| Person | Role | Try this |
| --- | --- | --- |
| Sara | clerk | Sales page: complete a quick sale, create an invoice. She cannot see cash or the ledger. |
| Karim | manager | Approve a bill from Sara. Take the ETA connection offline. Lock a period. |
| Hossam | accountant | Ledger page: post a manual journal entry, reverse an entry (a reason is required). Banking: import a CSV. |
| Laila | auditor | Read everything, change nothing. |
| Mona | owner | Everything, including Reports and Inventory. |
| Omar | admin / developer | Users, roles, API keys, webhooks. Sees no money. |

A good first five minutes:

1. As **Sara**, open **Sales** and complete a quick sale. Turn **Simulate offline** on as **Karim** first to see the e-receipt queue.
2. As **Karim**, open **Tax** and watch the queued receipt; use *Advance clock* to pass the 24-hour deadline.
3. As **Hossam**, open **Ledger** and try reversing an entry without a reason (it is refused), then with one.
4. As **Mona**, open **Reports** for the dashboard, trial balance and balance sheet.
5. Click **العربية** to switch to Arabic and right-to-left layout.

## 4. Run the checks

```
npm test            # unit and HTTP tests
npm run coverage    # tests with coverage thresholds
npm run check       # repository conventions
```

Browser checks (need Python and Playwright once: `pip install playwright && playwright install chromium`):

```
python3 e2e/run_all.py
```

## 5. Sign-in required mode

By default the demo trusts the user menu (no passwords). To require real sign-in:

```
AUTH_REQUIRED=1 INITIAL_OWNER_PASSWORD='choose-a-long-password' npm start
```

See [security.md](security.md) for MFA, API keys and webhooks.

## 6. Regenerate the screenshots and demo video

```
python3 scripts/capture-media.py     # writes docs/img/*.png and docs/img/demo.mp4 (needs ffmpeg)
```

## 7. Docker and free hosting

```
docker build -t accounting-poc . && docker run -p 3000:3000 accounting-poc
```

For Render, see [DEPLOY.md](DEPLOY.md). The free tier sleeps when idle and resets data on restart; set `AUTH_REQUIRED=1`
before sharing the URL.
