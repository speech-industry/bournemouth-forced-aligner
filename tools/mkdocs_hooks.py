"""MkDocs hook for the documentation site (see mkdocs.yml).

The pages in docs/ link to files elsewhere in the repository with ordinary relative links
(`../bournemouth_aligner/segmental/aligner.py`, `../evaluation/plots/summary_f1.png`), so
they also work when the Markdown is read on GitHub. The site only contains docs/, so at
build time:

- an image outside docs/ is copied into the site under _repo/ and the link points there;
- any other link outside docs/ becomes a link to the file on GitHub.
"""
import os
import re

from mkdocs.structure.files import File

ASSET_DIR = "_repo"
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"}
BRANCH = "main"
LINK = re.compile(r"(\]\()([^)\s]+)(\))")


def _root(config):
    return os.path.dirname(os.path.abspath(config.config_file_path))


def _outside(src_uri, target, config):
    """(repo path, anchor, is_dir) for a relative link that leaves docs/, else None."""
    if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", target) or target.startswith(("#", "/")):
        return None
    path, _, anchor = target.partition("#")
    docs, root = os.path.abspath(config.docs_dir), _root(config)
    full = os.path.normpath(os.path.join(docs, os.path.dirname(src_uri), path))
    if full == docs or full.startswith(docs + os.sep):
        return None
    rel = os.path.relpath(full, root)
    if rel.startswith(".."):
        return None
    return rel.replace(os.sep, "/"), anchor, path.endswith("/") or os.path.isdir(full)


def _map_links(markdown, fn):
    """Apply fn to every link target outside fenced code blocks."""
    out, fence = [], False
    for line in markdown.split("\n"):
        if line.lstrip().startswith(("```", "~~~")):
            fence = not fence
        elif not fence:
            line = LINK.sub(lambda m: m.group(1) + fn(m.group(2)) + m.group(3), line)
        out.append(line)
    return "\n".join(out)


def _is_image(rel):
    return os.path.splitext(rel)[1].lower() in IMAGE_EXT


def on_files(files, config):
    root = _root(config)
    for page in list(files.documentation_pages()):
        with open(page.abs_src_path, encoding="utf-8") as f:
            text = f.read()
        found = []

        def collect(target):
            hit = _outside(page.src_uri, target, config)
            if hit and _is_image(hit[0]) and os.path.isfile(os.path.join(root, hit[0])):
                found.append(hit[0])
            return target

        _map_links(text, collect)
        for rel in found:
            uri = f"{ASSET_DIR}/{rel}"
            if files.get_file_from_path(uri) is None:
                files.append(File.generated(config, uri, abs_src_path=os.path.join(root, rel)))
    return files


def on_page_markdown(markdown, page, config, files):
    repo = (config.repo_url or "").rstrip("/")
    here = os.path.dirname(page.file.src_uri) or "."

    def rewrite(target):
        hit = _outside(page.file.src_uri, target, config)
        if hit is None:
            return target
        rel, anchor, is_dir = hit
        if _is_image(rel) and files.get_file_from_path(f"{ASSET_DIR}/{rel}") is not None:
            return os.path.relpath(f"{ASSET_DIR}/{rel}", here).replace(os.sep, "/")
        kind = "tree" if is_dir else "blob"
        return f"{repo}/{kind}/{BRANCH}/{rel.rstrip('/')}" + (f"#{anchor}" if anchor else "")

    return _map_links(markdown, rewrite)
