const crypto = require('crypto');

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  // Using PBKDF2 with SHA256 to match the Worker implementation
  const iterations = 100000;
  const keyLength = 32; // 256 bits
  
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, keyLength, 'sha256', (err, derivedKey) => {
      if (err) reject(err);
      const combined = Buffer.concat([salt, derivedKey]);
      resolve(combined.toString('base64'));
    });
  });
}

const pass = 'Admin123!';
hashPassword(pass).then(hash => {
  console.log('--- INITIAL ADMIN SQL ---');
  console.log(`INSERT INTO users (id, email, password_hash, role, must_reset_password, created_at)`);
  console.log(`VALUES ('${crypto.randomUUID()}', 'admin@nimbus.com', '${hash}', 'admin', 0, '${new Date().toISOString()}');`);
});
