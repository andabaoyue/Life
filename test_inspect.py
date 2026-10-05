import subprocess, time
from playwright.sync_api import sync_playwright

srv = subprocess.Popen(['python', '-m', 'http.server', '8811', '--bind', '127.0.0.1'], cwd='d:/GAME/LIFE')
time.sleep(1)

try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe', args=['--no-sandbox'])
        with open('test/ui_test.py', 'r', encoding='utf-8') as f:
            c = f.read()
        mock = c.split('MOCK = """')[1].split('"""')[0]
        pg2 = b.new_page(viewport={'width': 340, 'height': 480})
        pg2.on('console', lambda m: print('CONSOLE:', m.type, m.text))
        pg2.on('pageerror', lambda e: print('PAGE_ERROR:', e))
        pg2.add_init_script(mock)
        pg2.goto('http://127.0.0.1:8811/index.html')
        pg2.wait_for_timeout(2000)
        
        # Test loading each layer individually in browser
        res = pg2.evaluate('''async () => {
          const srcs = [
            'assets/character/base/base.png',
            'assets/character/hair/silver_wavy_01.png',
            'assets/character/hair-accessories/black_bow_01.png',
            'assets/character/tops/lace_corset_01.png',
            'assets/character/bottoms/black_shorts_01.png',
            'assets/character/socks/white_thighhigh_01.png',
            'assets/character/shoes/black_boots_01.png',
            'assets/character/outerwear/white_tech_jacket_01.png'
          ];
          const results = [];
          for (const s of srcs) {
            const ok = await new Promise(res => {
              const im = new Image();
              im.onload = () => res(true);
              im.onerror = () => res(false);
              im.src = s;
            });
            results.push({src: s, ok});
          }
          return results;
        }''')
        print('LAYER TEST RESULTS:')
        for r in res:
            print(r)
        b.close()
finally:
    srv.kill()
