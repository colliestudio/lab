# Memory of the Tauri Canvas app: shell + sidecar + its WebKit processes (pids from the app's log,
# Networking matched by start time to the first WebContent).
import subprocess, re, os, datetime
log = open(os.path.expanduser('~/Library/Application Support/studio.collie.canvas.spike/canvas.log')).read()
pids = set()
for a,b in re.findall(r'web/gpu process \((\-?\d+), (\-?\d+)\)', log): pids |= {a,b}
ps = subprocess.run(['ps','-axo','pid=,lstart=,rss=,command='],capture_output=True,text=True).stdout.splitlines()
rows = {}; starts = {}
for l in ps:
    m = re.match(r'\s*(\d+)\s+(\w+ \w+\s+\d+ [\d:]+ \d+)\s+(\d+)\s+(.*)', l)
    pid, st, rss, cmd = m.groups()
    starts[pid] = (datetime.datetime.strptime(st, '%a %b %d %H:%M:%S %Y'), cmd, int(rss))
mine = [p for p,(t,c,r) in starts.items() if re.match(r'\S*desktop-tauri\S*/(Canvas.app/Contents/MacOS|target/debug)/canvas-(desktop|service)', c)]
web = [p for p in pids if p in starts and 'WebContent' in starts[p][1]]
t0 = min(starts[p][0] for p in web)
net = [p for p,(t,c,r) in starts.items() if 'WebKit.Networking' in c and abs((t - t0).total_seconds()) <= 1]
tot_r = tot_f = 0
for p in dict.fromkeys(mine + sorted(pids & set(starts)) + net):
    fp = subprocess.run(['footprint','-p',p],capture_output=True,text=True).stdout
    m = re.search(r'Footprint:\s*([\d.]+)\s*([KMG]B)', fp)
    f = float(m.group(1))*{'KB':1/1024,'MB':1,'GB':1024}[m.group(2)] if m else 0
    r = starts[p][2]/1024; tot_r += r; tot_f += f
    print(f"  {p:>6} {starts[p][1].split()[0].split('/')[-1][:30]:<30} rss {r:6.1f} MB  footprint {f:6.1f} MB")
print(f"  TOTAL rss {tot_r:.0f} MB, footprint {tot_f:.0f} MB")
