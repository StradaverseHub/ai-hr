"""WSGI entry point for production servers (gunicorn/uwsgi).

    gunicorn --workers 3 --bind 127.0.0.1:8000 wsgi:app

The Flask dev server (`python app.py`) is for local use only.
"""
from app import app

if __name__ == "__main__":
    app.run()
