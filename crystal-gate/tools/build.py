#!/usr/bin/env python3
"""index_template.html + scenes_data.js → dist/index.html（可發佈的單一 HTML）。

用法:
    python3 build.py <index_template.html> <scenes_data.js> <dist_dir> [three.min.js]

不給 three.min.js 就維持模板裡的 CDN 引用（jsdelivr, three@0.128.0）；
有給的話另外輸出 dist/index_local.html，把 three.js 內嵌進去，
方便在無外網環境（無頭瀏覽器錄影、離線展示）使用。
"""
import os, re, sys

def main():
    if len(sys.argv) < 4:
        print(__doc__); sys.exit(1)
    tpl_path, data_path, dist = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(dist, exist_ok=True)
    tpl = open(tpl_path).read()
    data = open(data_path).read()
    assert "/*__SCENES_DATA__*/" in tpl, "template placeholder missing"
    art = tpl.replace("/*__SCENES_DATA__*/", data)
    out = os.path.join(dist, "index.html")
    open(out, "w").write(art)
    print(out, f"{os.path.getsize(out)/1e6:.2f} MB")
    if len(sys.argv) > 4:
        three = open(sys.argv[4]).read()
        local = re.sub(r"<!--THREE_SRC-->.*?<!--/THREE_SRC-->",
                       lambda m: "<script>\n" + three + "\n</script>", art, flags=re.S)
        outl = os.path.join(dist, "index_local.html")
        open(outl, "w").write(local)
        print(outl, f"{os.path.getsize(outl)/1e6:.2f} MB")

if __name__ == "__main__":
    main()
