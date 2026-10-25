"""
Fetching URLs that came from random web pages. Every policy link is untrusted,
so before each hop (including redirects) we check where it actually resolves.
Blocks loopback, private, link-local, multicast and reserved ranges unless
PRIVANY_ALLOW_LOCAL=1 (demo mode).
"""

import asyncio
import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import urljoin, urlparse

import httpx

from . import config


class FetchError(Exception):
    pass


@dataclass
class Fetched:
    url: str            # final URL after redirects
    content: bytes
    content_type: str


def is_local_name(host: str) -> bool:
    """localhost and *.localhost: browsers send these to your own machine (RFC 6761)."""
    host = (host or "").lower().rstrip(".")
    return host == "localhost" or host.endswith(".localhost")


def _ip_allowed(ip: str) -> bool:
    addr = ipaddress.ip_address(ip)
    if config.ALLOW_LOCAL and (addr.is_loopback or addr.is_private):
        return True
    return addr.is_global and not addr.is_multicast


async def check_url(url: str) -> str:
    p = urlparse(url)
    if p.scheme not in ("http", "https"):
        raise FetchError(f"blocked scheme: {p.scheme or 'none'}")
    if not p.hostname:
        raise FetchError("no hostname")
    if p.username or p.password:
        raise FetchError("credentials in URL not allowed")
    if is_local_name(p.hostname):
        if config.ALLOW_LOCAL:
            return url
        raise FetchError(f"{p.hostname} is a local address")
    port = p.port or (443 if p.scheme == "https" else 80)
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(p.hostname, port, type=socket.SOCK_STREAM)
    except socket.gaierror as e:
        raise FetchError(f"can't resolve {p.hostname}") from e
    ips = {i[4][0] for i in infos}
    bad = [ip for ip in ips if not _ip_allowed(ip)]
    if bad:
        raise FetchError(f"{p.hostname} resolves to a non-public address")
    return url


async def fetch(url: str) -> Fetched:
    headers = {"User-Agent": config.USER_AGENT, "Accept": "text/html,application/pdf,text/plain;q=0.9,*/*;q=0.5"}
    async with httpx.AsyncClient(follow_redirects=False, timeout=config.FETCH_TIMEOUT, headers=headers) as client:
        current = url
        for _ in range(config.MAX_REDIRECTS + 1):
            await check_url(current)
            target, extra = current, {}
            cp = urlparse(current)
            if is_local_name(cp.hostname) and cp.hostname != "localhost":
                # Python's resolver doesn't know *.localhost; connect to loopback, keep the Host header
                target = cp._replace(netloc=f"127.0.0.1:{cp.port or 80}").geturl()
                extra = {"Host": cp.netloc}
            async with client.stream("GET", target, headers=extra) as resp:
                if resp.status_code in (301, 302, 303, 307, 308):
                    loc = resp.headers.get("location")
                    if not loc:
                        raise FetchError("redirect without location")
                    current = urljoin(current, loc)
                    continue
                if resp.status_code >= 400:
                    raise FetchError(f"HTTP {resp.status_code}")
                ctype = resp.headers.get("content-type", "").split(";")[0].strip().lower()
                if ctype and not (ctype.startswith("text/") or ctype in ("application/pdf", "application/xhtml+xml", "application/json")):
                    raise FetchError(f"unsupported content type {ctype}")
                chunks, size = [], 0
                async for chunk in resp.aiter_bytes():
                    size += len(chunk)
                    if size > config.MAX_DOC_BYTES:
                        raise FetchError("document too large")
                    chunks.append(chunk)
                return Fetched(url=current, content=b"".join(chunks), content_type=ctype or "text/html")
        raise FetchError("too many redirects")
