-- Reference data. Names and order follow Dr. Khan's review (13 Oct 2026).

INSERT INTO subjects (id, name, sort) VALUES
 (1,'Anatomy',1),(2,'Behavioral Science',2),(3,'Biochemistry',3),(4,'Biostatistics',4),
 (5,'Embryology',5),(6,'Genetics',6),(7,'Histology',7),(8,'Immunology',8),(9,'Microbiology',9),
 (10,'Pathology',10),(11,'Pathophysiology',11),(12,'Pharmacology',12),(13,'Physiology',13);

-- Performance by System: exactly these eight, in this order.
INSERT INTO perf_systems (id, name, sort) VALUES
 (1,'Reproductive & Endocrine Systems',1),
 (2,'Respiratory and Renal/Urinary Systems',2),
 (3,'Behavioral Health & Nervous Systems/Special Senses',3),
 (4,'Blood & Lymphoreticular/Immune Systems',4),
 (5,'Multisystem Processes & Disorders',5),
 (6,'Musculoskeletal, Skin & Subcutaneous Tissue',6),
 (7,'Cardiovascular System',7),
 (8,'Gastrointestinal System',8);

-- Performance by Discipline: exactly these ten, in this order.
INSERT INTO disciplines (id, name, sort) VALUES
 (1,'Pathology',1),(2,'Physiology',2),(3,'Microbiology & Immunology',3),(4,'Nutrition',4),
 (5,'Gross Anatomy & Embryology',5),(6,'Pharmacology',6),(7,'Behavioral Sciences',7),
 (8,'Biochemistry',8),(9,'Histology & Cell Biology',9),(10,'Genetics',10);

-- The 26 builder systems, each with a SUGGESTED reporting system (faculty confirm per question).
INSERT INTO systems (id, name, sort, suggested_perf_system_id) VALUES
 (1,'Biochemistry (General Principles)',1,5),
 (2,'Genetics (General Principles)',2,5),
 (3,'Microbiology (General Principles)',3,5),
 (4,'Pathology (General Principles)',4,5),
 (5,'Pharmacology (General Principles)',5,5),
 (6,'Biostatistics & Epidemiology',6,5),
 (7,'Poisoning & Environmental Exposure',7,5),
 (8,'Psychiatric/Behavioral & Substance Abuse',8,3),
 (9,'Social Sciences (Ethics/Legal/Professional)',9,5),
 (10,'Miscellaneous (Multisystem)',10,5),
 (11,'Allergy & Immunology',11,4),
 (12,'Cardiovascular System',12,7),
 (13,'Dermatology',13,6),
 (14,'Ear, Nose & Throat (ENT)',14,3),
 (15,'Endocrine, Diabetes & Metabolism',15,1),
 (16,'Female Reproductive System & Breast',16,1),
 (17,'Gastrointestinal & Nutrition',17,8),
 (18,'Hematology & Oncology',18,4),
 (19,'Infectious Diseases',19,5),
 (20,'Male Reproductive System',20,1),
 (21,'Nervous System',21,3),
 (22,'Ophthalmology',22,3),
 (23,'Pregnancy, Childbirth & Puerperium',23,1),
 (24,'Pulmonary & Critical Care',24,2),
 (25,'Renal, Urinary Systems & Electrolytes',25,2),
 (26,'Rheumatology/Orthopedics & Sports',26,6);

-- Suggested discipline per subject (Biostatistics and Pathophysiology are left for faculty to choose).
INSERT INTO subject_discipline_suggestions (subject_id, discipline_id) VALUES
 (1,5),(2,7),(3,8),(5,5),(6,10),(7,9),(8,3),(9,3),(10,1),(12,6),(13,2);

INSERT INTO packages (id, name, tagline, price_cents, one_on_one_sessions, evening_q_months, recommended, sort) VALUES
 ('refresher','USMLE100 MedSchool Refresher','A systematic review of medical school material before or during dedicated prep',150000,0,0,0,1),
 ('companion','USMLE100 MedSchool Companion','A full foundational review plus consistent live question practice',199900,0,4,0,2),
 ('complete','USMLE100 MedSchool Complete','Comprehensive prep plus one-to-one help on specific weaknesses',244900,10,4,1,3),
 ('max','USMLE100 MedSchool MAX','Intensive one-to-one mentorship alongside the full curriculum',379900,40,4,0,4);
