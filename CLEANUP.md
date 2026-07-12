# Files removed — delete these on your machine too

`Copy-Item -Force` overwrites files. It never deletes them. So anything I remove
lives on in your folder, invisible to the app but visible to `tsc` — which scans
every .ts in src/ and fails on the stale ones.

Run this once:

    Remove-Item C:\Users\newne\hispren\src\platform\events.ts -Force -ErrorAction SilentlyContinue
    Remove-Item C:\Users\newne\hispren\migrations\008_optout.sql -Force -ErrorAction SilentlyContinue
    Remove-Item C:\Users\newne\hispren\scripts\setup_app_role.sql -Force -ErrorAction SilentlyContinue
    Remove-Item C:\Users\newne\hispren\tests\isolation.test.ts -Force -ErrorAction SilentlyContinue
