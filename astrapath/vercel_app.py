"""Vercel ASGI entry point with the packaged Linux library loaded first."""

from ctypes import CDLL, RTLD_GLOBAL
from importlib import import_module
from pathlib import Path


expat = Path(__file__).resolve().parent / "_vercel_lib" / "libexpat.so.1"
if expat.is_file():
    CDLL(str(expat), mode=RTLD_GLOBAL)

app = import_module("astrapath.api").app
