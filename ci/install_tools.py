"""Install explicitly pinned upstream tools; hashes are reviewed with workflow changes."""

import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import urllib.request


def main():
    lock = json.loads(Path(__file__).with_name("tools.json").read_text())
    destination = Path(".ci-tools")
    destination.mkdir(exist_ok=True)
    for name in sys.argv[1:]:
        tool = lock[name]
        with urllib.request.urlopen(tool["url"], timeout=120) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != tool["sha256"]:
            raise RuntimeError("Checksum mismatch: " + name)
        target = destination / tool["binary"]
        if tool["url"].endswith(".jar"):
            target.write_bytes(data)
        else:
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
                member = archive.getmember(tool["binary"])
                if not member.isfile():
                    raise RuntimeError("Expected regular binary: " + name)
                target.write_bytes(archive.extractfile(member).read())
            os.chmod(target, 0o755)
        print("Verified tool:", name, tool["sha256"])


if __name__ == "__main__":
    main()
