"""Bundle Rasterio's system Expat dependency from the Vercel Linux build image."""

from pathlib import Path
from shutil import copy2


def bundle_expat():
    destination = Path(__file__).resolve().parent / "_vercel_lib"
    candidates = (
        Path("/usr/lib64/libexpat.so.1"),
        Path("/usr/lib/x86_64-linux-gnu/libexpat.so.1"),
    )
    source = next((path for path in candidates if path.is_file()), None)
    if source is None:
        raise RuntimeError("The Vercel build image does not provide libexpat.so.1.")
    destination.mkdir(exist_ok=True)
    copy2(source, destination / source.name)
    for notice in Path("/usr/share/licenses/expat").glob("*"):
        if notice.is_file():
            copy2(notice, destination / notice.name)
    print(f"Bundled {source.name} for the Rasterio runtime.")


if __name__ == "__main__":
    bundle_expat()
