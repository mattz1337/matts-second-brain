"""Orbit's read-only bridge. Runs in the existing Garmin chat image, never an LLM.

Mount Garmin activity/dashboard folders and /state read-only. The existing
chat_readonly database credential is consumed only inside this process.
"""
import hashlib
import hmac
import json
import math
import os
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, os.getenv('GARMIN_APP_ROOT', '/app'))
from app.chat.data import DataTools, validate_plan, basic_plan


def create_tools():
    auth = json.loads(Path(os.getenv('GARMIN_AUTH_FILE', '/state/auth.json')).read_text())
    return DataTools(os.getenv('DATA_DIR', '/data'), os.getenv('BRIDGE_STATE', '/bridge-state'),
                     influx_password=auth['influx_password'])


def make_handler(tools, token):
    if not isinstance(token, str) or len(token) < 32:
        raise ValueError('A connector token of at least 32 characters is required.')

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def respond(self, status, value):
            content = json.dumps(value, allow_nan=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(content)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.wfile.write(content)

        def authenticated(self):
            supplied = self.headers.get('Authorization', '')
            return not self.headers.get('Origin') and hmac.compare_digest(supplied, 'Bearer ' + token)

        def do_GET(self):
            if self.path == '/healthz':
                return self.respond(200, {'status': 'ok'})
            if not self.authenticated():
                return self.respond(401, {'error': 'Connector authentication required.'})
            if self.path == '/v1/status':
                return self.respond(200, {'version': 'orbit-garmin-v1', 'read_only': True,
                                          'last_sync': tools.store.status().get('last_success_utc')})
            return self.respond(404, {'error': 'Not found.'})

        def do_POST(self):
            if not self.authenticated():
                return self.respond(401, {'error': 'Connector authentication required.'})
            if self.path not in ('/v1/query', '/v1/question'):
                return self.respond(404, {'error': 'Not found.'})
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 8000:
                    return self.respond(413, {'error': 'Invalid request size.'})
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError('Invalid query.')
                if self.path == '/v1/question':
                    if set(body) != {'question'} or not isinstance(body['question'], str) or not 0 < len(body['question']) <= 2000:
                        raise ValueError('Invalid question.')
                    plan = basic_plan(body['question'])
                else:
                    if set(body) != {'plan'}:
                        raise ValueError('Invalid query.')
                    plan = validate_plan(body['plan'])
                result = tools.run(plan, '')
                # Return only calculated fields. Never raw records, activity names,
                # raw graph context, GPS, auth files or provider credentials.
                value = {key: result[key] for key in ('facts', 'chart', 'sources', 'last_sync', 'plan')}
                value.update(calculation_version='garmin-chat-v1', captured_at=datetime.now(timezone.utc).isoformat())
                serialized = json.dumps(value, sort_keys=True, allow_nan=False)
                value['snapshot_hash'] = hashlib.sha256(serialized.encode()).hexdigest()
                return self.respond(200, value)
            except (ValueError, KeyError, TypeError):
                return self.respond(400, {'error': 'Unsupported query or unavailable data. No values were inferred.'})
            except Exception:
                return self.respond(503, {'error': 'Garmin data is temporarily unavailable.'})

    return Handler


def main():
    secret = json.loads(Path(os.getenv('BRIDGE_TOKEN_FILE', '/run/secrets/garmin-bridge.json')).read_text())
    server = ThreadingHTTPServer(('0.0.0.0', 8082), make_handler(create_tools(), secret['token']))
    server.daemon_threads = True
    print('Orbit Garmin read-only bridge ready.', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
