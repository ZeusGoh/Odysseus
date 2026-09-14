# Turning on Cloud sync

Odysseus works entirely on one machine until you do this. Nothing below is
required — skip it and the app behaves as it always has, with everything in
this browser's localStorage and nothing leaving the computer.

Doing it gives you one thing: sign in on any laptop and your journal,
watchlist, alerts, and Logan's memory are already there.

It costs nothing. Firebase's free tier allows 1 GB of storage and 20,000
writes a day; this app, used hard by one person, uses a rounding error of that.

---

## 1. Make the Firebase project

1. Go to <https://console.firebase.google.com> and sign in with a Google account.
2. **Create a project**. Name it anything — `odysseus` is fine.
3. Google Analytics is offered. Turn it **off**; it does nothing for you here.

## 2. Register a web app and copy the config

1. On the project home screen, click the **web icon** (`</>`).
2. Give it a nickname (`odysseus-web`). Do **not** tick Firebase Hosting.
3. Firebase shows you a block of code containing `const firebaseConfig = { … }`.
   **Copy the whole block**, braces and all.

You do not need to hand-edit it into JSON. The Cloud panel takes what the
console gives you, quotes the bare keys itself, and tolerates single quotes and
a trailing comma.

> This config is not a secret. It identifies your project, it does not grant
> access to it — that is what the rules in step 4 are for. It is safe in the
> browser, which is why Google prints it on a page for you to copy.

## 3. Turn on email sign-in

1. Left sidebar → **Build → Authentication → Get started**.
2. **Sign-in method** tab → **Email/Password** → enable the first toggle
   (leave "Email link / passwordless" off) → **Save**.

## 4. Create the database and lock it down

1. Left sidebar → **Build → Firestore Database → Create database**.
2. Pick a location near you. It cannot be changed later.
3. Start in **production mode** — that denies everything by default, which is
   the right starting point.
4. Open the **Rules** tab, replace what is there with exactly this, and
   **Publish**:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

This is the part that makes it yours. It says: a signed-in account may read and
write documents under its own user ID and nowhere else. Without it — or with
the "test mode" rules Firebase offers — anyone who learns your project ID can
read your journal. Do not skip it, and do not leave test mode on.

## 5. Connect Odysseus

1. Serve the app rather than opening the file directly — Firebase Auth will not
   work from a `file://` page, which has no origin for it to check:

   ```
   cd path/to/VL
   python -m http.server 8000
   ```
   then open <http://localhost:8000/>.

2. **Cloud** tab → paste the config block into **Config** → **Save config**.
3. Enter an email and password and press **Create account**. This is a login
   for *your own* Firebase project; it is not a Google account and the password
   is not stored anywhere in the app.
4. It syncs immediately. From then on it syncs when you open the app and a few
   seconds after any change.

On a second machine, repeat steps 5.1–5.2 with the same config, then **Sign
in** with the same email and password. Everything comes down on first sync.

---

## What actually syncs

| Synced | Held back |
|---|---|
| Watchlist | Coin-name cache (`vl.coins.v2`) |
| Journal trades and settings | News "why" cache (`vl.why.v1`) |
| Logan's memory | |
| News settings | |
| Which alerts already fired | |

The two caches stay local on purpose: they are the largest things the app
holds, they rebuild from the network in seconds, and there is nothing in them
you would miss.

**API keys and the Telegram token** are held back too, unless you tick *Also
sync API keys and the Telegram token* in the Cloud panel. The rules above keep
them readable only by your account, but a key that can spend money is a
different thing to put on a server than a trade journal. Left off, you paste
your keys once per machine.

## How conflicts are settled

Per key, last edit wins — the app stamps every local write, so "this machine
changed it" and "the other machine changed it" are actually distinguishable.

If a sync is about to replace a local value with a different remote one, the
local copy is saved first under `vl.cloud.backup.<key>` in this browser's
localStorage. That only really happens the first time you sign in on a machine
that already had its own data. Nothing is thrown away silently.

Note what this is not: it is not a merge. If you add trades on two machines
without syncing in between, the later save wins for that key as a whole, and
the other machine's version is the one in the backup. In practice the app syncs
on open and a few seconds after each change, so that window is small.

## When something goes wrong

**`auth/unauthorized-domain`** — Firebase projects created since April 2025 no
longer authorize `localhost` automatically. Console → **Authentication →
Settings → Authorized domains → Add domain** → `localhost`.

**`permission-denied`** — the rules in step 4 were not published, or were
published with a different path. Re-paste them exactly.

**Nothing happens at all, and the badge says `local only`** — the config did
not save. The paste must include the `{ … }` braces.

**You want out** — sign out, or clear the Config box and save. The app returns
to local-only and every bit of your data is still in this browser. Deleting the
Firebase project removes the server copy for good.

## Going back to the local-only build

The version from before any of this exists three ways:

- `git checkout local-only-v1` (tag) or `git checkout local-only` (branch)
- `Downloads/VL-local-only/` — a standalone copy; open its `index.html` and it
  runs, knowing nothing about Firebase

They read the same `vl.*` localStorage keys, so the local-only build sees
whatever is on that machine, cloud or no cloud.
