// Example pages: a 4-screen signup/checkout flow, the kind of thing an agent generates.
// Links use `data-goto` (edge label or page title), fields `data-store`, values `data-show`.

const STYLE = `<style>
*{box-sizing:border-box}body{margin:0;font:16px/1.4 system-ui,-apple-system,sans-serif;color:#1d2433;background:#f6f7fb}
.bar{display:flex;align-items:center;gap:8px;padding:14px 18px;background:#fff;border-bottom:1px solid #e4e7ef;font-weight:600}
.bar .logo{width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,#6c5ce7,#00b894)}
main{padding:22px 20px}h1{font-size:26px;margin:8px 0 6px}p{color:#5b6475;margin:0 0 16px}
label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}
input,select{width:100%;padding:12px;border:1px solid #cfd5e3;border-radius:10px;font:inherit;background:#fff}
.btn{display:block;width:100%;margin-top:22px;padding:14px;border:0;border-radius:12px;background:#6c5ce7;color:#fff;font:600 16px system-ui;cursor:pointer;text-align:center;text-decoration:none}
.btn.ghost{background:transparent;color:#6c5ce7;border:1px solid #6c5ce7;margin-top:10px}
.card{background:#fff;border:2px solid #e4e7ef;border-radius:14px;padding:14px 16px;margin:10px 0;display:flex;justify-content:space-between;align-items:center;cursor:pointer}
.card.on{border-color:#6c5ce7;box-shadow:0 0 0 3px #6c5ce722}.price{font-weight:700}
.hero{height:200px;border-radius:18px;background:linear-gradient(135deg,#6c5ce7,#00b894);margin:4px 0 22px;display:grid;place-items:center;color:#fff;font:700 40px system-ui}
.muted{font-size:13px;color:#8a93a6;text-align:center;margin-top:14px}.row{display:flex;gap:10px}.row>*{flex:1}
.ok{width:84px;height:84px;border-radius:50%;background:#00b894;color:#fff;display:grid;place-items:center;font-size:44px;margin:30px auto 10px}
.back{color:#6c5ce7;text-decoration:none;font-weight:500;cursor:pointer}
</style>`;

const bar = (back = false) => `<div class="bar">${back ? '<a class="back" data-back>‹</a>' : ''}<div class="logo"></div>Brewly</div>`;

export const SEED_PAGES: { title: string; html: string; note?: string }[] = [
  {
    title: 'Landing',
    note: 'Hero copy is a placeholder. A/B test "Coffee, sorted" vs "Never run out".',
    html: `${STYLE}${bar()}<main>
<div class="hero">☕</div>
<h1>Coffee, sorted.</h1>
<p>Fresh beans from local roasters, delivered when you need them.</p>
<a class="btn" data-goto="Get started">Get started</a>
<p class="muted">Already a member? <a class="back" data-goto="Sign up">Log in</a></p>
</main>`,
  },
  {
    title: 'Sign up',
    note: 'Do we need the name field? Fewer fields = better conversion.',
    html: `${STYLE}${bar(true)}<main>
<h1>Create your account</h1>
<p>It takes 30 seconds.</p>
<form>
<label>Name</label><input data-store="name" required placeholder="Ada Lovelace">
<label>Email</label><input data-store="email" type="email" required placeholder="ada@example.com">
<label>Password</label><input type="password" required minlength="6" placeholder="6+ characters">
<button class="btn" data-goto="Continue">Continue</button>
</form>
</main>`,
  },
  {
    title: 'Plan',
    html: `${STYLE}${bar(true)}<main>
<h1>Pick a plan</h1>
<p>Hi <span data-show="name">there</span>, how much coffee do you drink?</p>
<div class="card" data-plan="Light · 250 g / month · $12"><div><b>Light</b><br><small>250 g / month</small></div><span class="price">$12</span></div>
<div class="card on" data-plan="Daily · 1 kg / month · $34"><div><b>Daily</b><br><small>1 kg / month</small></div><span class="price">$34</span></div>
<div class="card" data-plan="Office · 3 kg / month · $89"><div><b>Office</b><br><small>3 kg / month</small></div><span class="price">$89</span></div>
<a class="btn" data-goto="Checkout">Choose plan</a>
<script>
canvas.set('plan', canvas.state.plan || 'Daily · 1 kg / month · $34');
for (const c of document.querySelectorAll('.card')) {
  if (c.dataset.plan === canvas.state.plan) { document.querySelector('.card.on').classList.remove('on'); c.classList.add('on'); }
  c.onclick = () => { document.querySelector('.card.on').classList.remove('on'); c.classList.add('on'); canvas.set('plan', c.dataset.plan); };
}
</script>
</main>`,
  },
  {
    title: 'Checkout',
    note: 'Payment is fake. Real version: Stripe Elements. Apple Pay button?',
    html: `${STYLE}${bar(true)}<main>
<h1>Checkout</h1>
<p><span data-show="plan">Daily plan</span></p>
<form>
<label>Card number</label><input required inputmode="numeric" placeholder="4242 4242 4242 4242" data-store="card">
<div class="row"><div><label>Expiry</label><input required placeholder="MM/YY"></div><div><label>CVC</label><input required placeholder="123"></div></div>
<button class="btn" data-goto="Pay">Pay &amp; subscribe</button>
<a class="btn ghost" data-goto="Plan">Change plan</a>
</form>
</main>`,
  },
  {
    title: 'Welcome',
    html: `${STYLE}${bar()}<main style="text-align:center">
<div class="ok">✓</div>
<h1>You're in, <span data-show="name">friend</span>!</h1>
<p>We sent a receipt to <b data-show="email">your email</b>.<br>First bag ships tomorrow.</p>
<a class="btn" data-goto="Landing">Back to start</a>
</main>`,
  },
];

export const BLANK_HTML = `<style>body{font:16px system-ui;margin:0;padding:24px;background:#fff}</style>
<h1>New page</h1>
<p>Edit me (double-click the page). Link to another page with <code>data-goto="Page title"</code>.</p>
<button data-goto="">Next</button>`;
