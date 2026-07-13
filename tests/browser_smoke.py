"""
Headless browser smoke test for midpoint.
Verifies: page loads, no JS errors, two inputs work, button enables on valid geocode.

Usage:  /home/ubuntu/thaubot/venv/bin/python tests/browser_smoke.py
"""
import sys
import time
from playwright.sync_api import sync_playwright

URL = "http://localhost:8788/"

console_msgs = []
page_errors = []

def on_console(msg):
    console_msgs.append((msg.type, msg.text))

def on_pageerror(err):
    page_errors.append(str(err))

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    ctx = browser.new_context(ignore_https_errors=True)
    page = ctx.new_page()
    page.on("console", on_console)
    page.on("pageerror", on_pageerror)

    print(f"→ goto {URL}")
    page.goto(URL, wait_until="networkidle", timeout=15000)

    # Page title
    title = page.title()
    print(f"  title: {title!r}")
    assert "midpoint" in title.lower(), f"title wrong: {title}"

    # Inputs present
    page.wait_for_selector("#input-a", timeout=5000)
    page.wait_for_selector("#input-b", timeout=5000)
    page.wait_for_selector("#find-btn", timeout=5000)
    print("  ✓ inputs + button present")

    # Find button initially disabled
    btn_disabled = page.is_disabled("#find-btn")
    print(f"  ✓ find button initially disabled: {btn_disabled}")
    assert btn_disabled, "find button should be disabled initially"

    # Check map element
    page.wait_for_selector("#map", state="visible", timeout=3000)
    print("  ✓ map visible")

    # Type a real address for A
    page.fill("#input-a", "Taksim, Istanbul")
    print("  typed Person A address, waiting for geocode...")
    # Wait for the meta to populate (success)
    try:
        page.wait_for_function(
            "() => document.querySelector('[data-meta=\"a\"]').classList.contains('ok')",
            timeout=15000,
        )
        meta_a = page.locator('[data-meta="a"]').text_content()
        print(f"  ✓ A resolved: {meta_a[:80]}")
    except Exception as e:
        print(f"  ✗ A did not resolve: {e}")
        print(f"  meta text: {page.locator('[data-meta=a]').text_content()}")
        print(f"  console: {console_msgs[-5:]}")
        raise

    # Type a real address for B
    page.fill("#input-b", "Kadıköy, Istanbul")
    print("  typed Person B address, waiting for geocode...")
    page.wait_for_function(
        "() => document.querySelector('[data-meta=\"b\"]').classList.contains('ok')",
        timeout=15000,
    )
    meta_b = page.locator('[data-meta="b"]').text_content()
    print(f"  ✓ B resolved: {meta_b[:80]}")

    # Button should now be enabled
    btn_disabled = page.is_disabled("#find-btn")
    print(f"  ✓ find button enabled: {not btn_disabled}")
    assert not btn_disabled, "find button should be enabled now"

    # Click find
    print("  clicking find...")
    page.click("#find-btn")

    # Wait for results to appear
    page.wait_for_selector("#results:not([hidden])", timeout=30000)
    print("  ✓ results section visible")

    # Wait for at least one result item
    page.wait_for_function(
        "() => document.querySelectorAll('#result-list .result').length > 0",
        timeout=30000,
    )
    n_results = page.locator(".result").count()
    print(f"  ✓ {n_results} results rendered")
    assert n_results > 0, "no results"

    # Top result should have name + ETAs
    first = page.locator(".result").first
    name = first.locator(".result-name").text_content()
    eta_a = first.locator(".eta-a strong").text_content()
    eta_b = first.locator(".eta-b strong").text_content()
    print(f"  ✓ #1: {name!r}  A={eta_a}  B={eta_b}")

    # Map markers
    n_markers = page.locator(".side-marker, .midpoint-marker, .place-marker").count()
    print(f"  ✓ {n_markers} markers on map")

    # Hint should be OK
    hint = page.locator("#hint").text_content()
    print(f"  hint: {hint}")

    # Errors?
    if page_errors:
        print(f"\n  ✗ {len(page_errors)} page errors:")
        for e in page_errors:
            print(f"     {e}")
        sys.exit(1)
    print("\n  ✓ no JS errors")
    errs = [m for m in console_msgs if m[0] == "error"]
    warns = [m for m in console_msgs if m[0] == "warning"]
    if errs:
        print(f"  ✗ {len(errs)} console errors:")
        for t, msg in errs:
            print(f"     [{t}] {msg}")
        sys.exit(1)
    if warns:
        print(f"  ⚠ {len(warns)} console warnings (informational):")
        for t, msg in warns[:5]:
            print(f"     [{t}] {msg[:100]}")

    # Screenshot for visual verification
    page.screenshot(path="/tmp/midpoint-smoke.png", full_page=True)
    print(f"\n  📸 screenshot: /tmp/midpoint-smoke.png")

    browser.close()

print("\n✓ ALL CHECKS PASSED")