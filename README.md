# Minigame

Minigame Express + PostgreSQL.

## Chay local bang Docker

```bash
docker compose up --build
```

Mo game tai `http://localhost:3000`.

Trang admin tai `http://localhost:3000/admin`.

Tai khoan mac dinh:

```text
user: admid
pass: bantudethuong
```

Co the doi admin password bang file `.env` hoac bien moi truong:

```bash
ADMIN_PASS=mat-khau-moi docker compose up --build
```

## PostgreSQL

App dung bien `DATABASE_URL`. Khi server khoi dong, schema se tu duoc tao neu chua co:

- `plays`
- `settings`
- `campaign`

## Deploy Render

Repo da co `render.yaml`.

1. Day code len GitHub/GitLab/Bitbucket.
2. Vao Render Dashboard, chon `New` -> `Blueprint`.
3. Chon repo nay va apply blueprint.
4. Khi Render hoi `ADMIN_PASS`, nhap mat khau admin muon dung.
5. Cho deploy xong, mo URL `.onrender.com`.

Blueprint se tao:

- Web service Node.js chay `npm start`.
- Render Postgres database.
- `DATABASE_URL` noi tu dong vao database qua private network.
