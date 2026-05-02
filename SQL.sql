CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  api_token TEXT UNIQUE NOT NULL
);

CREATE TABLE pushplus_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token TEXT NOT NULL,
  note TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  pushplus_token_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT DEFAULT '',
  start_time TEXT NOT NULL,
  interval_hours INTEGER NOT NULL DEFAULT 0,
  status TEXT DEFAULT 'pending',
  next_remind_time TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (pushplus_token_id) REFERENCES pushplus_tokens(id)
);
