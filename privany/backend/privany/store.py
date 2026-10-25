"""
Small SQLite cache. Keys are hashes of policy URLs / site names, so the
database never holds a readable list of the sites people visited, and there's
no column for who asked.
"""

import hashlib
import json
import sqlite3
import time
from contextlib import closing

from . import config


def _key(*parts: str) -> str:
    return hashlib.sha256("|".join(parts).encode()).hexdigest()


def _conn():
    c = sqlite3.connect(config.DB_PATH)
    c.execute("CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY, created REAL, v TEXT)")
    return c


def get(kind: str, ident: str, max_age_s: float) -> dict | None:
    with closing(_conn()) as c:
        row = c.execute("SELECT created, v FROM cache WHERE k=?", (_key(kind, ident),)).fetchone()
    if row and time.time() - row[0] < max_age_s:
        return json.loads(row[1])
    return None


def put(kind: str, ident: str, value: dict) -> None:
    with closing(_conn()) as c, c:
        c.execute("INSERT OR REPLACE INTO cache VALUES (?,?,?)", (_key(kind, ident), time.time(), json.dumps(value)))


def purge(older_than_s: float) -> int:
    with closing(_conn()) as c, c:
        return c.execute("DELETE FROM cache WHERE created < ?", (time.time() - older_than_s,)).rowcount
