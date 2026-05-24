Method	Endpoint	Auth	Purpose
GET	/api/health	❌	API status
POST	/api/auth/register	❌	Local signup
POST	/api/auth/login	❌	Local login
POST	/api/auth/oauth/callback	❌	OAuth login
GET	/api/auth/verify-email	❌	Email verify
POST	/api/auth/forgot-password	❌	Reset request
POST	/api/auth/reset-password	❌	Reset confirm
POST	/api/auth/refresh	❌	Refresh token
POST	/api/auth/logout	✅	Logout
GET	/api/profile/me	✅	Own profile
PATCH	/api/profile/me	✅	Update profile
GET	/api/profile/:username	❌	Public profile
POST	/api/jobs/submit	✅ + credits	Submit AI job
GET	/api/jobs	✅	My jobs list
GET	/api/jobs/:id	✅	Job detail
GET	/api/jobs/:id/status	✅	Job status poll
PATCH	/api/jobs/:id/cancel	✅	Cancel job
GET	/api/credits/balance	✅	Credit balance
GET	/api/credits/transactions	✅	Credit history
GET	/api/credits/transactions/:id	✅	Single transaction
POST	/api/payments/initiate	✅	Start payment
POST	/api/payments/verify	✅	Verify payment
GET	/api/payments	✅	Payment history
GET	/api/payments/:id	✅	Single payment
GET	/api/admin/users	✅ 👑	All users
GET	/api/admin/users/:id	✅ 👑	User detail
PATCH	/api/admin/users/:id/block	✅ 👑	Block user
PATCH	/api/admin/users/:id/unblock	✅ 👑	Unblock user
POST	/api/admin/credits/adjust	✅ 👑	Manual credit adjust
GET	/api/admin/jobs	✅ 👑	All jobs oversight
GET	/api/admin/payments	✅ 👑	All payments oversight
