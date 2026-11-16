"""Microsoft Graph mailer for Leadership 360 reminder emails.

Sends through the company's Microsoft 365 using the Graph ``Mail.Send``
*application* permission (OAuth2 client-credentials flow). All credentials come
from environment variables ONLY — never hard-coded, never committed:

    GRAPH_TENANT_ID      Azure AD tenant (directory) id
    GRAPH_CLIENT_ID      app registration (client) id
    GRAPH_CLIENT_SECRET  app registration client secret   <- the one sensitive value
    GRAPH_SENDER         mailbox to send as
                         (default: group.people@example.com)

Until IT grants admin consent on Mail.Send and issues a client secret,
``is_configured()`` returns False and ``send_mail()`` raises
``MailerNotConfigured``. The rest of the app — and the ``--dry-run`` path of
send_reminders.py — works fine without any of this set.

Standard library only (urllib), so it adds no deployment dependency.
"""
import json
import os
import urllib.error
import urllib.parse
import urllib.request

GRAPH_BASE = "https://graph.microsoft.com/v1.0"
LOGIN_BASE = "https://login.microsoftonline.com"
DEFAULT_SENDER = "group.people@example.com"


class MailerError(RuntimeError):
    """A Graph token request or send call failed."""


class MailerNotConfigured(MailerError):
    """Graph credentials are not all present in the environment yet."""


def sender_address():
    return os.environ.get("GRAPH_SENDER", DEFAULT_SENDER)


def _creds():
    return (os.environ.get("GRAPH_TENANT_ID"),
            os.environ.get("GRAPH_CLIENT_ID"),
            os.environ.get("GRAPH_CLIENT_SECRET"))


def is_configured():
    """True only when all three Graph secrets are present in the environment."""
    return all(_creds())


def config_status():
    """Human-readable readiness summary for the admin UI (no secret values)."""
    tenant, client_id, secret = _creds()
    return {
        "configured": bool(tenant and client_id and secret),
        "sender": sender_address(),
        "has_tenant": bool(tenant),
        "has_client_id": bool(client_id),
        "has_secret": bool(secret),
    }


def _http_json(url, data=None, headers=None, method=None, timeout=20):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            return resp.status, (json.loads(body) if body.strip() else {})
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        raise MailerError(f"Graph HTTP {e.code}: {detail[:500]}")
    except urllib.error.URLError as e:
        raise MailerError(f"Network error reaching Graph: {e.reason}")


def get_token():
    """Fetch an app-only access token via client credentials."""
    tenant, client_id, secret = _creds()
    if not (tenant and client_id and secret):
        raise MailerNotConfigured(
            "Graph not configured: set GRAPH_TENANT_ID, GRAPH_CLIENT_ID and "
            "GRAPH_CLIENT_SECRET (GRAPH_SENDER optional).")
    data = urllib.parse.urlencode({
        "client_id": client_id,
        "client_secret": secret,
        "scope": "https://graph.microsoft.com/.default",
        "grant_type": "client_credentials",
    }).encode()
    url = f"{LOGIN_BASE}/{tenant}/oauth2/v2.0/token"
    _, body = _http_json(url, data=data, method="POST",
                         headers={"Content-Type": "application/x-www-form-urlencoded"})
    token = body.get("access_token")
    if not token:
        raise MailerError(f"No access_token in token response: {body}")
    return token


def send_mail(to_email, subject, html_body, token=None, save_to_sent=True, cc=None, attachments=None):
    """Send one HTML email as the configured sender. Raises MailerError on
    failure. Pass a pre-fetched ``token`` to reuse it across many sends (the
    client-credentials token is valid ~1h), avoiding a re-auth per message.
    ``to_email`` is one address or a list of them; ``cc`` an optional list
    (one email, everyone on it: the sign-in help request, 2026-10-19).
    ``attachments`` (2026-10-22, AI+ Learning's calendar invites): an optional
    list of {name, content_type, content}, content as text, or content_b64
    for a binary file already base64 (2026-10-23, a CHART certificate's PDF);
    None sends the email exactly as before.
    """
    if token is None:
        token = get_token()
    sender = sender_address()
    tos = [to_email] if isinstance(to_email, str) else list(to_email)
    message = {
        "subject": subject,
        "body": {"contentType": "HTML", "content": html_body},
        "toRecipients": [{"emailAddress": {"address": a}} for a in tos],
    }
    if cc:
        message["ccRecipients"] = [{"emailAddress": {"address": a}} for a in cc]
    if attachments:
        import base64
        message["attachments"] = [{
            "@odata.type": "#microsoft.graph.fileAttachment", "name": a["name"],
            "contentType": a.get("content_type") or "application/octet-stream",
            "contentBytes": a["content_b64"] if a.get("content_b64") else
            base64.b64encode(a["content"].encode("utf-8") if isinstance(a["content"], str)
                             else a["content"]).decode("ascii")} for a in attachments]
    payload = {"message": message, "saveToSentItems": bool(save_to_sent)}
    url = f"{GRAPH_BASE}/users/{urllib.parse.quote(sender)}/sendMail"
    _http_json(url, data=json.dumps(payload).encode(), method="POST",
               headers={"Authorization": f"Bearer {token}",
                        "Content-Type": "application/json"})
    return True  # Graph returns 202 Accepted on success


def meeting_mime(to_email, subject, html_body, ics_text, method="REQUEST"):
    """An Outlook meeting request (or its cancellation) as MIME (2026-10-24, AI+ Learning's calendar invites; Chris:
    "a real meeting request", "automatically on confirm"). The calendar is the email's own text/calendar part, not an
    attachment, so Outlook / Exchange files it in the calendar by itself (tentative until answered) and shows Accept /
    Decline; a later REQUEST with the same UID and a higher SEQUENCE updates it, a CANCEL removes it."""
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText
    msg = MIMEMultipart("alternative")
    msg["From"] = sender_address()
    msg["To"] = to_email
    msg["Subject"] = subject
    msg["Content-Class"] = "urn:content-classes:calendarmessage"
    msg.attach(MIMEText(html_body, "html", "utf-8"))
    cal = MIMEText(ics_text, "calendar", "utf-8")
    cal.set_param("method", method)
    msg.attach(cal)
    return msg.as_bytes()


def send_meeting(to_email, subject, html_body, ics_text, method="REQUEST", token=None):
    """Send one meeting request (meeting_mime) as the configured sender, through Graph's MIME send: the same
    Mail.Send permission as send_mail, the message base64 with Content-Type text/plain. Saved to Sent Items. Raises
    MailerError on failure."""
    import base64
    if token is None:
        token = get_token()
    url = f"{GRAPH_BASE}/users/{urllib.parse.quote(sender_address())}/sendMail"
    _http_json(url, data=base64.b64encode(meeting_mime(to_email, subject, html_body, ics_text, method)),
               method="POST", headers={"Authorization": f"Bearer {token}", "Content-Type": "text/plain"})
    return True


if __name__ == "__main__":
    # Quick connectivity check: `python3 mailer.py you@example.com`
    import sys
    st = config_status()
    print("Graph configured:", st["configured"], "| sender:", st["sender"])
    if len(sys.argv) > 1:
        if not st["configured"]:
            print("Not configured — set the GRAPH_* env vars first.")
            sys.exit(1)
        send_mail(sys.argv[1], "Leadership 360 — mailer test",
                  "<p>This is a test from the Leadership 360 mailer.</p>")
        print("Sent test email to", sys.argv[1])
