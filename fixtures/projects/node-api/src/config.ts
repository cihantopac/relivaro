export const config = {
  aws: { accessKeyId: '__RLV_SECRET_AWS__' }, // expect: sec/hardcoded-secret
  github: { token: '__RLV_SECRET_GITHUB__' }, // expect: sec/hardcoded-secret
  stripe: { key: process.env.STRIPE_SECRET_KEY },
  database: 'postgres://app:__RLV_SECRET_DBPASS__@db.internal:5432/app', // expect: sec/hardcoded-secret
  placeholder: { apiKey: 'your-api-key-here', password: 'changeme' },
};
