const keyId = process.env.RAZORPAY_KEY_ID;
const keySecret = process.env.RAZORPAY_KEY_SECRET;
if (!keyId || !keySecret) {
  throw new Error('Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET before provisioning plans');
}

const plans = [
  { code: 'pro', name: 'DS Agent Pro', amount: 99900, description: '100 analyses per billed workspace seat per month' },
  { code: 'business', name: 'DS Agent Business', amount: 249900, description: '500 analyses per billed workspace seat per month' },
];

for (const plan of plans) {
  const response = await fetch('https://api.razorpay.com/v1/plans', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      period: 'monthly',
      interval: 1,
      item: { name: plan.name, amount: plan.amount, currency: 'INR', description: plan.description },
      notes: { product: 'ds-agent', plan_code: plan.code },
    }),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(`Could not create ${plan.name} plan: ${result.error?.description || 'Razorpay request failed'}`);
  console.log(`${plan.code}: ${result.id}`);
}
