$root = $PSScriptRoot

Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\backend'; uvicorn main:app --reload"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\frontend'; npm run dev"
