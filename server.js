const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// Настройка для обслуживания статических файлов из папки 'public'
app.use(express.static(path.join(__dirname, 'public')));

// TODO: Замените на ваши учётные данные из Azure SQL Database.
// Рекомендуется использовать переменные окружения для безопасности.
const config = {
    user: 'umizoomi',
    password: '{your_password_here}', 
    server: 'umizoomi.database.windows.net',
    database: 'umizoomi_sql',
    options: {
        encrypt: true, // Требуется для Azure SQL
        trustServerCertificate: false 
    }
};

// Новый маршрут для главной страницы, который теперь является запасным
app.get('/', (req, res) => {
    res.status(200).send('Сайт работает!');
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    // Проверка наличия данных
    if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email и пароль обязательны' });
    }

    try {
        await sql.connect(config);
        const request = new sql.Request();
        
        // Используем параметризованные запросы для предотвращения SQL-инъекций
        request.input('email', sql.NVarChar, email);
        request.input('password', sql.NVarChar, password); 

        // Запрос к базе данных
        const result = await request.query('SELECT * FROM Users WHERE Email = @email AND Password = @password');
        
        if (result.recordset.length > 0) {
            res.status(200).json({ success: true, message: 'Вход успешен' });
        } else {
            res.status(200).json({ success: false, message: 'Неверный email или пароль' });
        }
    } catch (err) {
    console.error('Ошибка базы данных:', err);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
    } finally {
        sql.close(); // Всегда закрывайте соединение
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Сервер Node.js запущен на порту ${PORT}`);
}).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error('Ошибка: Порт уже используется. Перезапустите приложение или используйте другой порт.');
    } else {
        console.error('Ошибка запуска сервера:', err);
    }
});
