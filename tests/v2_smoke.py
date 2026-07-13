"""
Comprehensive v2 smoke test:
  - Page loads with Turkish (default detected)
  - Suggestion dropdowns work (typing shows multiple suggestions)
  - Clicking a suggestion selects it
  - Find Midpoint runs pipeline
  - Results render
  - Switching language to EN re-renders labels
"""
import time
import sys
from playwright.sync_api import sync_playwright

URL = "http://localhost:8788/"

errors = []
console_msgs = []

def on_console(msg):
    console_msgs.append((msg.type, msg.text))

def on_pageerror(err):
    errors.append(str(err))

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    ctx = browser.new_context(
        viewport={"width": 1280, "height": 900},
        locale="tr-TR",  # force Turkish browser locale
    )
    page = ctx.new_page()
    page.on("console", on_console)
    page.on("pageerror", on_pageerror)

    print("=" * 60)
    print("STEP 1: Load page with TR locale")
    print("=" * 60)
    page.goto(URL, wait_until="networkidle", timeout=15000)
    page.wait_for_selector("#input-a", timeout=5000)
    # Wait for i18n to apply
    time.sleep(0.4)

    lang = page.evaluate("document.documentElement.lang")
    print(f"  html lang = {lang!r}  (expect 'tr')")
    assert lang == "tr", f"expected tr, got {lang}"

    find_text = page.locator("#find-btn .btn-text").text_content()
    print(f"  find btn text = {find_text!r}  (expect 'ortayı bul')")
    assert "orta" in find_text.lower(), f"expected Turkish, got {find_text!r}"

    hint_text = page.locator("#hint").text_content()
    print(f"  hint = {hint_text!r}")
    assert "iki yer" in hint_text or "başlamak" in hint_text, f"expected TR hint, got {hint_text!r}"

    page.screenshot(path="/tmp/v2-1-tr-initial.png", full_page=True)

    print("\n" + "=" * 60)
    print("STEP 2: Type 'Taksim' in input A — expect suggestion dropdown")
    print("=" * 60)
    page.type("#input-a", "Taksim", delay=80)
    # Wait for suggestions to appear
    page.wait_for_function(
        "() => !document.querySelector('[data-suggestions=\"a\"]').hidden",
        timeout=8000,
    )
    n_sugg = page.locator('[data-suggestions="a"] .suggestion').count()
    print(f"  ✓ {n_sugg} suggestions shown")
    assert n_sugg >= 2, f"expected multiple suggestions, got {n_sugg}"

    first_sugg = page.locator('[data-suggestions="a"] .suggestion').first
    first_text = first_sugg.text_content()
    print(f"  first suggestion: {first_text[:80]!r}")

    page.screenshot(path="/tmp/v2-2-tr-suggestions.png", full_page=True)

    print("\n" + "=" * 60)
    print("STEP 3: Click first suggestion")
    print("=" * 60)
    first_sugg.click()
    time.sleep(0.5)
    sugg_hidden = page.locator('[data-suggestions="a"]').get_attribute("hidden")
    print(f"  suggestion list hidden after click: {sugg_hidden is not None}")
    meta_a = page.locator('[data-meta="a"]').text_content()
    print(f"  meta A: {meta_a[:80]!r}")

    print("\n" + "=" * 60)
    print("STEP 4: Type + select for B")
    print("=" * 60)
    page.type("#input-b", "Kadıköy", delay=80)
    page.wait_for_function(
        "() => !document.querySelector('[data-suggestions=\"b\"]').hidden",
        timeout=8000,
    )
    page.locator('[data-suggestions="b"] .suggestion').first.click()
    time.sleep(0.5)

    btn_disabled = page.is_disabled("#find-btn")
    print(f"  find btn disabled: {btn_disabled}  (expect False)")
    assert not btn_disabled

    page.screenshot(path="/tmp/v2-3-tr-ready.png", full_page=True)

    print("\n" + "=" * 60)
    print("STEP 5: Click find midpoint")
    print("=" * 60)
    page.click("#find-btn")
    page.wait_for_selector("#results:not([hidden])", timeout=30000)
    page.wait_for_function(
        "() => document.querySelectorAll('#result-list .result').length > 0",
        timeout=30000,
    )
    n_results = page.locator(".result").count()
    print(f"  ✓ {n_results} results")
    first = page.locator(".result").first
    name = first.locator(".result-name").text_content()
    eta_a = first.locator(".eta-a strong").text_content()
    eta_b = first.locator(".eta-b strong").text_content()
    print(f"  #1: {name!r}  A={eta_a}  B={eta_b}")

    page.screenshot(path="/tmp/v2-4-tr-results.png", full_page=True)

    print("\n" + "=" * 60)
    print("STEP 6: Switch to English")
    print("=" * 60)
    page.click('.lang-btn[data-lang="en"]')
    time.sleep(0.4)
    lang = page.evaluate("document.documentElement.lang")
    print(f"  html lang = {lang!r}")
    assert lang == "en"

    find_text = page.locator("#find-btn .btn-text").text_content()
    print(f"  find btn text = {find_text!r}  (expect 'find midpoint')")
    assert "find" in find_text.lower(), f"expected EN, got {find_text!r}"

    # Results should re-render with English labels
    first = page.locator(".result").first
    cat_text = first.locator(".result-cat").text_content()
    print(f"  result cat (EN): {cat_text[:60]!r}")
    # 'cafe' / 'restaurant' / 'bar' are valid in both langs but 'park' differs
    # 'restoran' (TR) -> 'restaurant' (EN), 'cafe' (same)

    page.screenshot(path="/tmp/v2-5-en-after-switch.png", full_page=True)

    # Switch back to TR
    page.click('.lang-btn[data-lang="tr"]')
    time.sleep(0.3)
    lang = page.evaluate("document.documentElement.lang")
    assert lang == "tr"
    print(f"  ✓ switched back to TR")

    print("\n" + "=" * 60)
    print("STEP 7: Test default-locale detection (EN browser → EN UI)")
    print("=" * 60)
    ctx2 = browser.new_context(viewport={"width": 1280, "height": 900}, locale="en-US")
    page2 = ctx2.new_page()
    page2.goto(URL, wait_until="domcontentloaded")
    page2.wait_for_selector("#input-a")
    time.sleep(0.4)
    lang = page2.evaluate("document.documentElement.lang")
    print(f"  html lang (en-US browser) = {lang!r}")
    assert lang == "en", f"expected auto-detect en, got {lang}"

    print("\n" + "=" * 60)
    print("STEP 8: Mobile viewport — stacked layout")
    print("=" * 60)
    ctx3 = browser.new_context(viewport={"width": 390, "height": 844}, locale="en-US")
    page3 = ctx3.new_page()
    page3.goto(URL, wait_until="domcontentloaded")
    page3.wait_for_selector("#input-a")
    time.sleep(0.4)
    page3.screenshot(path="/tmp/v2-6-mobile.png", full_page=True)
    print(f"  ✓ mobile screenshot saved")

    if errors:
        print("\n  ✗ page errors:")
        for e in errors: print(f"     {e}")
        sys.exit(1)
    err_console = [m for m in console_msgs if m[0] == "error"]
    if err_console:
        print("\n  ✗ console errors:")
        for t, msg in err_console:
            print(f"     [{t}] {msg[:200]}")
        sys.exit(1)

    print("\n✓ ALL V2 CHECKS PASSED")
    browser.close()