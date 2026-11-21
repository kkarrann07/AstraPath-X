"""Show the dashboard mounted next to Streamlit on the same ASGI server."""
import streamlit as st


st.set_page_config(page_title="AstraPath-X", layout="wide")
st.link_button("Open dashboard in a full tab", "/mission/")
st.iframe("/mission/", height=1050, tab_index=0, alt="AstraPath-X rover mission dashboard")
