import { useCallback, useEffect, useState } from 'react';
import Sidebar from '../components/Sidebar.jsx';
import Aurora from '../components/Aurora.jsx';
import { billing as billingApi } from '../utils/api.js';
import { C, G, GLOBAL_CSS } from '../utils/design.js';

function loadRazorpayCheckout() {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = resolve;
    script.onerror = () => reject(new Error('Could not load Razorpay Checkout.'));
    document.body.appendChild(script);
  });
}

export default function Billing() {
  const [plans, setPlans] = useState([]);
  const [account, setAccount] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loadingPlan, setLoadingPlan] = useState('');
  const [loading, setLoading] = useState(true);
  const [seatQuantity, setSeatQuantity] = useState('1');

  const refresh = useCallback(async () => {
    setError('');
    try {
      const [plansResponse, accountResponse] = await Promise.all([billingApi.plans(), billingApi.me()]);
      setPlans(plansResponse.data.plans);
      setAccount(accountResponse.data);
      setSeatQuantity(String(accountResponse.data.seats?.billed || 1));
    } catch (requestError) {
      setError(requestError.response?.data?.error || 'Could not load billing details.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const subscribe = async planCode => {
    setLoadingPlan(planCode);
    setMessage('');
    setError('');
    try {
      const { data } = await billingApi.subscribe(planCode);
      if (data.demo_checkout) {
        setMessage(data.message);
        await refresh();
        return;
      }
      await loadRazorpayCheckout();
      const checkout = new window.Razorpay({
        key: data.key_id,
        subscription_id: data.subscription_id,
        name: 'DS Agent',
        description: `${data.plan.name} monthly subscription`,
        prefill: data.prefill,
        theme: { color: '#8B7CF8' },
        handler: async response => {
          try {
            const verified = await billingApi.verify(response);
            setMessage(verified.data.message);
            await refresh();
          } catch (requestError) {
            setError(requestError.response?.data?.error || 'Could not verify the checkout response.');
          } finally {
            setLoadingPlan('');
          }
        },
        modal: { ondismiss: () => setLoadingPlan('') },
      });
      checkout.on('payment.failed', response => {
        setError(response.error?.description || 'Razorpay payment failed.');
        setLoadingPlan('');
      });
      checkout.open();
    } catch (requestError) {
      setError(requestError.response?.data?.error || requestError.message || 'Could not start checkout.');
      setLoadingPlan('');
    }
  };

  const cancel = async () => {
    setError('');
    setMessage('');
    try {
      const response = await billingApi.cancel();
      setMessage(response.data.message);
      await refresh();
    } catch (requestError) {
      setError(requestError.response?.data?.error || 'Could not cancel subscription.');
    }
  };

  const updateDemoSeats = async event => {
    event.preventDefault();
    setError('');
    setMessage('');
    try {
      const { data } = await billingApi.setSeats(Number(seatQuantity));
      setMessage(data.message);
      await refresh();
    } catch (requestError) {
      setError(requestError.response?.data?.error || 'Could not change demo seats.');
    }
  };

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, display: 'flex', fontFamily: 'system-ui,-apple-system,sans-serif' }}>
      <style>{GLOBAL_CSS}</style>
      <Aurora />
      <aside style={{ width: 220, minHeight: '100vh', padding: '16px 10px', position: 'sticky', top: 0, height: '100vh', flexShrink: 0, zIndex: 10 }}>
        <Sidebar />
      </aside>
      <main style={{ flex: 1, padding: 28, position: 'relative', zIndex: 1, maxWidth: 1200, margin: '0 auto' }}>
        <h1 style={{ fontSize: 24, marginBottom: 8 }}>Plans and usage</h1>
        <p style={{ color: C.muted, marginBottom: 24 }}>Paid plans are billed per workspace seat each month.</p>
        {plans.some(plan => plan.checkoutMode === 'demo') &&
          <p role="status" style={{ ...G.panel({ padding: 12, marginBottom: 16 }), color: C.amber }}>
            Demo billing is active: plans change locally; no payment is collected.
          </p>}
        {error && <p role="alert" style={{ color: C.coral, marginBottom: 16 }}>{error}</p>}
        {message && <p role="status" style={{ color: C.teal, marginBottom: 16 }}>{message}</p>}

        {loading ? <p style={{ color: C.muted }}>Loading billing details...</p> : account && (
          <section style={{ ...G.panel({ padding: 20, marginBottom: 24 }) }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
              <div>
                <strong>{account.plan.name} plan</strong>
                <p style={{ color: C.muted, fontSize: 13, marginTop: 6 }}>
                  {account.used} of {account.limit || account.plan.analysesPerMonth} analyses used this month
                  {account.seats && ` · ${account.seats.used} seats (${account.seats.billed} billed)`}
                  {account.subscription && ` · Subscription ${account.subscription.status}`}
                </p>
              </div>
              {account.subscription?.status === 'active' && !account.subscription.cancel_at_cycle_end &&
                <button onClick={cancel} style={{ ...G.btn('rgba(255,83,112,0.12)'), color: C.coral, border: `1px solid ${C.coral}55` }}>Cancel at period end</button>}
            </div>
            {account.subscription?.status === 'active' && !account.subscription.cancel_at_cycle_end && (
              <form onSubmit={updateDemoSeats} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16 }}>
                <label htmlFor="workspace-seat-count" style={{ fontSize: 12, color: C.muted }}>Billed seats</label>
                <input id="workspace-seat-count" type="number" min={account.seats.used} max="100" value={seatQuantity}
                  onChange={event => setSeatQuantity(event.target.value)} style={{ ...G.input(), width: 90 }} />
                <button style={G.btn('rgba(94,207,178,0.12)')}>Update seats</button>
              </form>
            )}
          </section>
        )}

        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(230px,1fr))', gap: 16 }}>
          {plans.map(plan => (
            <article key={plan.code} style={G.panel({ padding: 22, borderColor: plan.code === 'pro' ? 'rgba(139,124,248,0.45)' : C.border })}>
              <h2 style={{ fontSize: 18, marginBottom: 8 }}>{plan.name}</h2>
              <div style={{ fontSize: 25, fontWeight: 800, marginBottom: 4 }}>
                {plan.priceInr === 0 ? 'Free' : `₹${plan.priceInr.toLocaleString('en-IN')}`}
                {plan.priceInr > 0 && <span style={{ fontSize: 12, color: C.muted, fontWeight: 500 }}> / seat / month</span>}
              </div>
              <p style={{ color: C.muted, fontSize: 13, minHeight: 40 }}>{plan.description}</p>
              <ul style={{ paddingLeft: 18, color: C.muted, fontSize: 13, lineHeight: 1.8, minHeight: 120 }}>
                {plan.features.map(feature => <li key={feature}>{feature}</li>)}
              </ul>
              {plan.code === 'free' ? (
                <div style={{ color: C.teal, fontSize: 13 }}>Included for every account</div>
              ) : (
                (() => {
                  const subscription = account?.subscription;
                  const resumable = ['created', 'authenticated'].includes(subscription?.status) &&
                    subscription.plan_code === plan.code;
                  const subscriptionExists = subscription && subscription.status !== 'failed' &&
                    subscription.status !== 'cancelled' && subscription.status !== 'completed';
                  const disabled = !plan.checkoutEnabled || loadingPlan !== '' || (subscriptionExists && !resumable);
                  return (
                    <button
                      disabled={disabled}
                      onClick={() => subscribe(plan.code)}
                      style={{ ...G.btn('linear-gradient(135deg,#8B7CF8,#6B5CE7)'), width: '100%', opacity: disabled ? 0.6 : 1 }}
                    >
                      {loadingPlan === plan.code ? 'Starting...' : resumable ? 'Continue checkout' : subscriptionExists ? 'Subscription already active' : plan.checkoutMode === 'demo' ? `Try ${plan.name} demo` : plan.checkoutEnabled ? `Choose ${plan.name}` : 'Payment setup required'}
                    </button>
                  );
                })()
              )}
            </article>
          ))}
        </section>
      </main>
    </div>
  );
}
