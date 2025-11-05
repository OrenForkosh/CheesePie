# CheesePie Lab Tools

## Project Overview

This project is a Python-based Flask web application designed for scientific media analysis. It provides a suite of tools for browsing, preprocessing (including arena/background/region definition), annotating, and importing media files. A key feature is its optional integration with the MATLAB Engine, allowing for the execution of MATLAB functions directly from the Python backend.

The application is structured as a modular Flask app, with different functionalities broken down into separate blueprints. This makes the codebase easier to maintain and extend. The frontend is built with standard HTML, CSS, and JavaScript.

## Building and Running

### With Docker

The most straightforward way to run the project is using Docker.

1.  **Build the Docker image:**
    ```bash
    docker build -t cheesepie .
    ```

2.  **Run the Docker container:**
    ```bash
    docker run -p 8000:8000 -v $(pwd):/srv/cheesepie cheesepie
    ```

Alternatively, you can use the provided `docker-compose.yml` file:

```bash
docker-compose up
```

### Local Development

1.  **Create a virtual environment:**
    ```bash
    python3 -m venv .venv
    source .venv/bin/activate
    ```

2.  **Install dependencies:**
    ```bash
    pip install -r requirements.txt
    ```

3.  **Run the application:**
    ```bash
    python app.py
    ```

The application will be available at `http://localhost:8000`.

### Start Scripts

The project includes convenient start scripts for different operating systems:

*   **macOS/Linux:**
    ```bash
    chmod +x start.sh && ./start.sh
    ```

*   **Windows (PowerShell):**
    ```bash
    pwsh -File scripts/start.ps1
    ```

These scripts handle the creation of a virtual environment, installation of dependencies, and running the application.

## Development Conventions

*   **Modular Structure:** The application is divided into modules and blueprints to keep the code organized. New features should be added in their own blueprints or by extending existing ones.
*   **Configuration:** The application is configured through the `config.json` file. This file contains settings for the annotator, browser, facilities, importer, and MATLAB integration.
*   **MATLAB Integration:** The MATLAB integration is optional and can be enabled in the `config.json` file. The `matlab.whitelist` setting in the configuration file is a security measure to control which MATLAB functions can be executed from the application.
*   **Authentication:** The application has a simple authentication system that uses a secret key. The secret key is generated automatically and stored in the `cheesepie` directory.
*   **Code Style:** The code follows standard Python conventions (PEP 8).
