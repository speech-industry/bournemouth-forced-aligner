# Package metadata, dependencies and extras live in pyproject.toml. The package list is here
# because one directory is mapped: ./web_interface (top level, so it has its own place on
# GitHub) installs as `bournemouth_aligner.web_interface`.
from setuptools import find_packages, setup

setup(
    packages=find_packages(include=["bournemouth_aligner*"],
                           exclude=["tests*", "examples*"])
    + ["bournemouth_aligner.web_interface"],
    package_dir={"bournemouth_aligner.web_interface": "web_interface"},
)
