"""Streamlit Community Cloud entry point for the complete AstraPath-X dashboard."""
from pathlib import Path
import sys

import streamlit as st
from starlette.routing import Mount


HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from astrapath.api import app as mission_api

app = st.App(HERE / "dashboard.py", routes=[Mount("/mission", app=mission_api)])
