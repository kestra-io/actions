#!/usr/bin/env python3
"""Convert Jacoco XML coverage reports into a single Cobertura XML report.

GitHub's native code coverage API (actions/upload-code-coverage) only accepts
Cobertura, while Gradle's jacoco plugin only emits its own format, so the two
need a translation step in between.

Jacoco identifies a file by its java package plus its source file name
(`io/kestra/core` + `Worker.java`). That is not a path that exists in a Gradle
build, where the same file lives at `core/src/main/java/io/kestra/core/Worker.java`.
Cobertura's `<sources>` element is meant to carry those prefixes, but consumers
disagree on how to apply them when a report declares several roots -- which is
exactly the case for the multi-module builds here. So instead of emitting
prefixes and hoping, every file is resolved against the checkout and written out
as a repository-relative path. Files that cannot be found in the checkout are
dropped: for kestra-ee the OSS modules are built from a sibling `../kestra`
directory, and coverage for sources that are not in this repository has nothing
to annotate.
"""

import argparse
import os
import sys
import time
import xml.etree.ElementTree as ET
from collections import defaultdict

# Directories that never hold sources we want to resolve against, but do hold
# enough files to make walking the tree noticeably slower. Pruning `build` also
# excludes generated sources (the protobuf classes under worker-controller, for
# instance): jacoco measures them, but they are not committed, so GitHub has
# nothing to annotate and they would only drag the reported percentage down.
PRUNED_DIRS = {".git", ".gradle", "node_modules", "build", "out", "target", ".idea", "venv", ".venv"}

SOURCE_EXTENSIONS = (".java", ".kt", ".kts", ".groovy", ".scala")


def find_jacoco_reports(root):
    """Return every jacoco XML report under `root`'s gradle build directories."""
    reports = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in (".git", "node_modules")]
        if os.path.basename(dirpath) != "jacoco":
            continue
        if os.path.basename(os.path.dirname(dirpath)) != "reports":
            continue
        for sub_dirpath, _, sub_filenames in os.walk(dirpath):
            reports.extend(
                os.path.join(sub_dirpath, name)
                for name in sub_filenames
                if name.endswith(".xml")
            )
    return sorted(reports)


def index_sources(root):
    """Map each source file name to the repository-relative paths that carry it."""
    index = defaultdict(list)
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in PRUNED_DIRS]
        for name in filenames:
            if name.endswith(SOURCE_EXTENSIONS):
                path = os.path.relpath(os.path.join(dirpath, name), root)
                index[name].append(path.replace(os.sep, "/"))
    return index


def resolve_path(index, package, source_name):
    """Resolve a jacoco (package, source file) pair to a path in the checkout."""
    candidates = index.get(source_name)
    if not candidates:
        return None

    suffix = "{}/{}".format(package, source_name) if package else source_name
    matches = [path for path in candidates if path == suffix or path.endswith("/" + suffix)]
    if not matches:
        return None
    if len(matches) == 1:
        return matches[0]

    # A class compiled from both a main and a test source set, or shared by two
    # modules, resolves to several paths. Prefer production sources, then pick
    # the shortest remaining path so the choice is stable across runs.
    main_matches = [path for path in matches if "/src/main/" in path]
    return sorted(main_matches or matches, key=lambda path: (len(path), path))[0]


class FileCoverage:
    """Merged line counters for a single source file."""

    def __init__(self, path, package):
        self.path = path
        self.package = package
        self.lines = {}

    def add_line(self, number, covered_instructions, total_instructions, covered_branches, total_branches):
        previous = self.lines.get(number)
        if previous is None:
            self.lines[number] = [covered_instructions, total_instructions, covered_branches, total_branches]
            return
        # The same file can appear in several reports (a per-module report and
        # an aggregated one). Keep the most favourable observation per line so
        # merging stays idempotent when reports are exact copies.
        previous[0] = max(previous[0], covered_instructions)
        previous[1] = max(previous[1], total_instructions)
        previous[2] = max(previous[2], covered_branches)
        previous[3] = max(previous[3], total_branches)

    @property
    def totals(self):
        lines_covered = lines_valid = branches_covered = branches_valid = 0
        for covered_instructions, _, covered_branches, total_branches in self.lines.values():
            lines_valid += 1
            if covered_instructions > 0:
                lines_covered += 1
            branches_covered += covered_branches
            branches_valid += total_branches
        return lines_covered, lines_valid, branches_covered, branches_valid


def rate(covered, valid):
    return covered / valid if valid else 0.0


def read_report(path, index, files):
    """Merge one jacoco report into `files`, keyed by repository-relative path."""
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError as error:
        print("::warning::Skipping unreadable jacoco report {}: {}".format(path, error))
        return

    for package in root.iter("package"):
        package_name = package.get("name", "")
        for source_file in package.findall("sourcefile"):
            source_name = source_file.get("name")
            if not source_name:
                continue
            resolved = resolve_path(index, package_name, source_name)
            if resolved is None:
                continue

            coverage = files.get(resolved)
            if coverage is None:
                coverage = FileCoverage(resolved, package_name.replace("/", "."))
                files[resolved] = coverage

            for line in source_file.findall("line"):
                covered_instructions = int(line.get("ci", 0))
                missed_instructions = int(line.get("mi", 0))
                covered_branches = int(line.get("cb", 0))
                missed_branches = int(line.get("mb", 0))
                coverage.add_line(
                    int(line.get("nr")),
                    covered_instructions,
                    covered_instructions + missed_instructions,
                    covered_branches,
                    covered_branches + missed_branches,
                )


def build_cobertura(files):
    lines_covered = lines_valid = branches_covered = branches_valid = 0
    for coverage in files.values():
        file_lines_covered, file_lines_valid, file_branches_covered, file_branches_valid = coverage.totals
        lines_covered += file_lines_covered
        lines_valid += file_lines_valid
        branches_covered += file_branches_covered
        branches_valid += file_branches_valid

    coverage_element = ET.Element(
        "coverage",
        {
            "line-rate": "{:.4f}".format(rate(lines_covered, lines_valid)),
            "branch-rate": "{:.4f}".format(rate(branches_covered, branches_valid)),
            "lines-covered": str(lines_covered),
            "lines-valid": str(lines_valid),
            "branches-covered": str(branches_covered),
            "branches-valid": str(branches_valid),
            "complexity": "0",
            "version": "jacoco-to-cobertura",
            "timestamp": str(int(time.time() * 1000)),
        },
    )
    # Paths are already repository-relative, so the only source root is the root.
    sources = ET.SubElement(coverage_element, "sources")
    ET.SubElement(sources, "source").text = "."

    packages_element = ET.SubElement(coverage_element, "packages")
    by_package = defaultdict(list)
    for coverage in files.values():
        by_package[coverage.package].append(coverage)

    for package_name in sorted(by_package):
        package_files = sorted(by_package[package_name], key=lambda item: item.path)
        package_lines_covered = package_lines_valid = 0
        package_branches_covered = package_branches_valid = 0
        for coverage in package_files:
            file_totals = coverage.totals
            package_lines_covered += file_totals[0]
            package_lines_valid += file_totals[1]
            package_branches_covered += file_totals[2]
            package_branches_valid += file_totals[3]

        package_element = ET.SubElement(
            packages_element,
            "package",
            {
                "name": package_name,
                "line-rate": "{:.4f}".format(rate(package_lines_covered, package_lines_valid)),
                "branch-rate": "{:.4f}".format(rate(package_branches_covered, package_branches_valid)),
                "complexity": "0",
            },
        )
        classes_element = ET.SubElement(package_element, "classes")

        for coverage in package_files:
            file_lines_covered, file_lines_valid, file_branches_covered, file_branches_valid = coverage.totals
            class_name = os.path.splitext(os.path.basename(coverage.path))[0]
            class_element = ET.SubElement(
                classes_element,
                "class",
                {
                    "name": "{}.{}".format(package_name, class_name) if package_name else class_name,
                    "filename": coverage.path,
                    "line-rate": "{:.4f}".format(rate(file_lines_covered, file_lines_valid)),
                    "branch-rate": "{:.4f}".format(rate(file_branches_covered, file_branches_valid)),
                    "complexity": "0",
                },
            )
            # Jacoco reports lines per source file rather than per method, and
            # the DTD orders `methods` before `lines`, so emit an empty element.
            ET.SubElement(class_element, "methods")
            lines_element = ET.SubElement(class_element, "lines")

            for number in sorted(coverage.lines):
                covered_instructions, _, covered_branches, total_branches = coverage.lines[number]
                attributes = {
                    "number": str(number),
                    "hits": "1" if covered_instructions > 0 else "0",
                    "branch": "true" if total_branches else "false",
                }
                if total_branches:
                    percentage = int(round(100 * covered_branches / total_branches))
                    attributes["condition-coverage"] = "{}% ({}/{})".format(
                        percentage, covered_branches, total_branches
                    )
                ET.SubElement(lines_element, "line", attributes)

    return coverage_element, lines_covered, lines_valid


def set_output(name, value):
    output_file = os.environ.get("GITHUB_OUTPUT")
    if output_file:
        with open(output_file, "a", encoding="utf-8") as handle:
            handle.write("{}={}\n".format(name, value))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, help="Path of the Cobertura report to write")
    parser.add_argument("--root", default=".", help="Repository root to resolve source paths against")
    arguments = parser.parse_args()

    root = os.path.abspath(arguments.root)
    reports = find_jacoco_reports(root)
    if not reports:
        print("No jacoco XML report found, skipping Cobertura conversion.")
        set_output("found", "false")
        return 0

    print("Converting {} jacoco report(s):".format(len(reports)))
    for report in reports:
        print("  {}".format(os.path.relpath(report, root)))

    files = {}
    index = index_sources(root)
    for report in reports:
        read_report(report, index, files)

    if not files:
        print("::warning::No jacoco coverage could be matched to sources in this checkout.")
        set_output("found", "false")
        return 0

    coverage_element, lines_covered, lines_valid = build_cobertura(files)
    ET.indent(coverage_element, space="  ")
    tree = ET.ElementTree(coverage_element)

    os.makedirs(os.path.dirname(os.path.abspath(arguments.output)) or ".", exist_ok=True)
    with open(arguments.output, "wb") as handle:
        handle.write(b'<?xml version="1.0" ?>\n')
        handle.write(b"<!DOCTYPE coverage SYSTEM 'http://cobertura.sourceforge.net/xml/coverage-04.dtd'>\n")
        tree.write(handle, encoding="utf-8", xml_declaration=False)

    print(
        "Wrote {} covering {} file(s): {}/{} lines ({:.2f}%).".format(
            arguments.output, len(files), lines_covered, lines_valid, 100 * rate(lines_covered, lines_valid)
        )
    )
    set_output("found", "true")
    return 0


if __name__ == "__main__":
    sys.exit(main())
